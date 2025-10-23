import {
  ElectricityAvailabilityService,
} from '@electrobot/electricity-availability';
import { UserRepository } from '@electrobot/user-repo';
import { Injectable, Logger } from '@nestjs/common';
import {
  addMinutes,
  addMonths,
  differenceInMinutes,
  format,
  formatDistance,
  getMonth,
} from 'date-fns';
import { convertToTimeZone } from 'date-fns-timezone';
import { uk } from 'date-fns/locale';
import * as TelegramBot from 'node-telegram-bot-api';
import { Bot, Place } from '@electrobot/domain';
import { PlaceRepository } from '@electrobot/place-repo';
import {
  EMOJ_BULB,
  EMOJ_KISS,
  EMOJ_KISS_HEART,
  EMOJ_MOON,
  MSG_DISABLED_REGULAR_SUFFIX,
  RESP_ABOUT,
  RESP_CURRENTLY_AVAILABLE,
  RESP_CURRENTLY_UNAVAILABLE,
  RESP_DISABLED_DETAILED,
  RESP_DISABLED_SHORT,
  RESP_DISABLED_SUSPICIOUS,
  RESP_ENABLED_DETAILED,
  RESP_ENABLED_SHORT,
  RESP_PREVIOUS_MONTH_SUMMARY,
  RESP_NO_CURRENT_INFO,
  RESP_START,
  RESP_SUBSCRIPTION_ALREADY_EXISTS,
  RESP_SUBSCRIPTION_CREATED,
  RESP_UNSUBSCRIBED,
  RESP_WAS_NOT_SUBSCRIBED,
  RESP_ENABLED_SUSPICIOUS,
  MSG_DISABLED,
} from './messages.constant';

const MIN_SUSPICIOUS_DISABLE_TIME_IN_MINUTES = 30;
const BULK_NOTIFICATION_DELAY_IN_MS = 50;

@Injectable()
export class NotificationBotService {
  private readonly logger = new Logger(NotificationBotService.name);
  private places: Record<string, Place> = {};
  private placeBots: Record<
    string,
    {
      readonly bot: Bot;
      readonly telegramBot: TelegramBot;
    }
  > = {};
  private isRefreshingPlacesAndBots = false;

  constructor(
    private readonly electricityAvailabilityService: ElectricityAvailabilityService,
    private readonly userRepository: UserRepository,
    private readonly placeRepository: PlaceRepository
  ) {
    this.logger.log('Initializing NotificationBotService...');
    this.refreshAllPlacesAndBots().then(() => {
      this.logger.log(
        `Initial refresh complete. Loaded ${Object.keys(this.places).length} places and ${Object.keys(this.placeBots).length} bots.`
      );
    });

    const refreshRate = 10 * 60 * 1000; // 10 min
    setInterval(() => this.refreshAllPlacesAndBots(), refreshRate);

    this.electricityAvailabilityService.availabilityChange$.subscribe(
      ({ placeId }) => {
        this.logger.log(
          `[Subscription] Received electricity availability change for ${placeId}`
        );
        this.notifyAllPlaceSubscribersAboutElectricityAvailabilityChange({
          placeId,
        });
      }
    );
  }

  public async notifyAllPlacesAboutPreviousMonthStats(): Promise<void> {
    this.logger.log('notifyAllPlacesAboutPreviousMonthStats started');
    const allPlaces = Object.values(this.places);

    for (const place of allPlaces) {
      if (place.isDisabled || place.disableMonthlyStats) {
        this.logger.verbose(`Skipping monthly notification for ${place.name}`);
        continue;
      }
      await this.notifyAllPlaceSubscribersAboutPreviousMonthStats({ place });
    }
    this.logger.log('notifyAllPlacesAboutPreviousMonthStats finished');
  }

  // --- handleStartCommand ---
  private async handleStartCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    this.logger.log(`[handleStartCommand] Called for place ${place.name}`);

    if (this.isGroup({ chatId: msg.chat.id })) {
      this.logger.warn(`Skipping group message: ${JSON.stringify(msg)}`);
      return;
    }

    if (place.isDisabled) {
      await this.notifyBotDisabled({ chatId: msg.chat.id, telegramBot });
      return;
    }

    await this.userRepository.saveUserAction({
      placeId: place.id,
      chatId: msg.chat.id,
      command: 'start',
    });

    const listedBotsMessage = await this.composeListedBotsMessage();

    await telegramBot.sendMessage(
      msg.chat.id,
      RESP_START({ place: place.name, listedBotsMessage }),
      { parse_mode: 'HTML' }
    );
  }

  // --- handleCurrentCommand ---
  private async handleCurrentCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    this.logger.log(`[handleCurrentCommand] Called for ${place.name}`);

    if (this.isGroup({ chatId: msg.chat.id })) return;

    if (place.isDisabled) {
      await this.notifyBotDisabled({ chatId: msg.chat.id, telegramBot });
      return;
    }

    const [latest] =
      await this.electricityAvailabilityService.getLatestPlaceAvailability({
        placeId: place.id,
        limit: 1,
      });

    if (!latest) {
      this.logger.warn(`No latest availability found for ${place.name}`);
      await telegramBot.sendMessage(
        msg.chat.id,
        RESP_NO_CURRENT_INFO({ place: place.name }),
        { parse_mode: 'HTML' }
      );
      return;
    }

    const changeTime = convertToTimeZone(latest.time, {
      timeZone: place.timezone,
    });
    const now = convertToTimeZone(new Date(), { timeZone: place.timezone });
    const when = format(changeTime, 'd MMMM о HH:mm', { locale: uk });
    const howLong = formatDistance(now, changeTime, { locale: uk });

    const response = latest.isAvailable
      ? RESP_CURRENTLY_AVAILABLE({
          when,
          howLong,
          place: place.name,
          scheduleDisableMoment: undefined,
          schedulePossibleDisableMoment: undefined,
        })
      : RESP_CURRENTLY_UNAVAILABLE({
          when,
          howLong,
          place: place.name,
          scheduleEnableMoment: undefined,
          schedulePossibleEnableMoment: undefined,
        });

    await telegramBot.sendMessage(msg.chat.id, response, { parse_mode: 'HTML' });
  }

  // --- refreshAllPlacesAndBots ---
  private async refreshAllPlacesAndBots(): Promise<void> {
    if (this.isRefreshingPlacesAndBots) {
      this.logger.warn('refreshAllPlacesAndBots skipped (already running)');
      return;
    }

    this.isRefreshingPlacesAndBots = true;
    this.logger.log('refreshAllPlacesAndBots started');

    try {
      const places = await this.placeRepository.getAllPlaces();
      const placeBots = await this.placeRepository.getAllPlaceBots();

      this.logger.log(`Fetched ${places.length} places from DB`);
      this.logger.log(`Fetched ${placeBots.length} bot configs from DB`);

      this.places = places.reduce<Record<string, Place>>((res, place) => {
        res[place.id] = place;
        return res;
      }, {});

      for (const bot of placeBots) {
        if (!bot.isEnabled) continue;
        const place = this.places[bot.placeId];
        if (!place) {
          this.logger.error(
            `Bot ${bot.botName} references missing place ${bot.placeId}`
          );
          continue;
        }

        if (!this.placeBots[bot.placeId]) {
          this.createBot({ place, bot });
        } else {
          this.logger.verbose(
            `Bot already exists for ${place.name}, skipping creation`
          );
        }
      }
    } catch (e) {
      this.logger.error(`refreshAllPlacesAndBots failed: ${e?.message}`, e);
    } finally {
      this.isRefreshingPlacesAndBots = false;
      this.logger.log(
        `refreshAllPlacesAndBots finished. Total bots: ${Object.keys(
          this.placeBots
        ).length}`
      );
    }
  }

  // --- createBot ---
  private createBot(params: { readonly place: Place; readonly bot: Bot }): void {
    const { place, bot } = params;
    this.logger.log(
      `[createBot] Creating bot ${bot.botName} for place ${place.name}`
    );

    try {
      const telegramBot = new TelegramBot(bot.token);
      this.placeBots[bot.placeId] = { bot, telegramBot };

      telegramBot.on('polling_error', (error) => {
        this.logger.error(`${place.name}/${bot.botName} polling error: ${error}`);
      });

      telegramBot.onText(/\/start/, (msg) =>
        this.handleStartCommand({ msg, place, bot, telegramBot })
      );
      telegramBot.onText(/\/current/, (msg) =>
        this.handleCurrentCommand({ msg, place, bot, telegramBot })
      );

      this.logger.log(
        `[createBot] Bot ${bot.botName} initialized successfully for ${place.name}`
      );
    } catch (err) {
      this.logger.error(`[createBot] Failed for ${place.name}: ${err.message}`);
    }
  }

  private async sleep(params: { readonly ms: number }): Promise<void> {
    return new Promise((r) => setTimeout(r, params.ms));
  }

  public getMainTelegramBotInstance(): TelegramBot | undefined {
    const keys = Object.keys(this.placeBots);
    this.logger.log(
      `[getMainTelegramBotInstance] called. Existing bot keys: ${JSON.stringify(
        keys
      )}`
    );
    const activeBotEntry = Object.values(this.placeBots).find(
      (entry) => entry.bot.isEnabled
    );

    if (activeBotEntry) {
      this.logger.log(
        `[getMainTelegramBotInstance] Returning active bot for ${
          activeBotEntry.bot.botName
        }`
      );
      return activeBotEntry.telegramBot;
    } else {
      this.logger.warn(
        '[getMainTelegramBotInstance] No active bot instance found!'
      );
      return undefined;
    }
  }
}
