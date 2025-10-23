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
    this.logger.log('[INIT] NotificationBotService constructor called.');
    this.refreshAllPlacesAndBots().then(() => {
      this.logger.log(
        `[INIT] Initial refresh complete. Total bots in memory: ${Object.keys(
          this.placeBots
        ).length}`
      );
    });

    const refreshRate = 10 * 60 * 1000; // 10 min
    setInterval(() => this.refreshAllPlacesAndBots(), refreshRate);

    this.electricityAvailabilityService.availabilityChange$.subscribe(
      ({ placeId }) => {
        this.logger.verbose(`[EVENT] Availability changed for place ${placeId}`);
        this.notifyAllPlaceSubscribersAboutElectricityAvailabilityChange({
          placeId,
        });
      }
    );
  }

  private async refreshAllPlacesAndBots(): Promise<void> {
    if (this.isRefreshingPlacesAndBots) {
      this.logger.warn('[REFRESH] Already running, skipping parallel call.');
      return;
    }

    this.isRefreshingPlacesAndBots = true;
    this.logger.log('[REFRESH] Starting refreshAllPlacesAndBots...');
    try {
      const places = await this.placeRepository.getAllPlaces();
      this.logger.log(`[REFRESH] Loaded ${places.length} places from DB.`);

      this.places = places.reduce<Record<string, Place>>(
        (res, place) => ({ ...res, [place.id]: place }),
        {}
      );

      const placeBots = await this.placeRepository.getAllPlaceBots();
      this.logger.log(`[REFRESH] Loaded ${placeBots.length} bot configs from DB.`);
      this.logger.debug(`[REFRESH] placeBots IDs: ${JSON.stringify(placeBots.map(b => b.placeId))}`);

      let createdBots = 0;

      placeBots.forEach((bot) => {
        if (!bot.isEnabled) {
          this.logger.warn(`[REFRESH] Bot ${bot.botName} (${bot.placeId}) disabled, skipping.`);
          return;
        }

        const place = this.places[bot.placeId];
        if (!place) {
          this.logger.error(`[REFRESH] Place ${bot.placeId} not found — cannot create bot.`);
          return;
        }

        if (this.placeBots[bot.placeId]) {
          this.logger.log(`[REFRESH] Bot already exists for ${place.name}, updating metadata.`);
          this.placeBots[bot.placeId] = {
            ...this.placeBots[bot.placeId],
            bot,
          };
        } else {
          this.logger.log(`[REFRESH] Creating new bot for ${place.name} (${bot.placeId})`);
          this.createBot({ place, bot });
          createdBots++;
        }
      });

      this.logger.log(
        `[REFRESH] Completed. Active bot instances: ${Object.keys(this.placeBots).length}, created this round: ${createdBots}`
      );
    } catch (e) {
      this.logger.error(`[REFRESH] Failed with error: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.isRefreshingPlacesAndBots = false;
    }
  }

  private createBot(params: { readonly place: Place; readonly bot: Bot }): void {
    const { place, bot } = params;

    this.logger.log(
      `[BOT_INIT] Creating Telegram bot for ${place.name} (${place.id}), token prefix: ${bot.token.substring(
        0,
        8
      )}...`
    );

    try {
      const telegramBot = new TelegramBot(bot.token);

      this.placeBots[bot.placeId] = { bot, telegramBot };

      this.logger.log(
        `[BOT_INIT] Successfully created bot for ${place.name}. Total bots in memory: ${Object.keys(
          this.placeBots
        ).length}`
      );

      telegramBot.on('polling_error', (error) => {
        this.logger.error(
          `[BOT_INIT] Polling error for ${place.name}/${bot.botName}: ${error}`
        );
      });

      telegramBot.onText(/\/start/, (msg) =>
        this.handleStartCommand({ msg, place, bot, telegramBot })
      );
      telegramBot.onText(/\/current/, (msg) =>
        this.handleCurrentCommand({ msg, place, bot, telegramBot })
      );
      telegramBot.onText(/\/subscribe/, (msg) =>
        this.handleSubscribeCommand({ msg, place, bot, telegramBot })
      );
      telegramBot.onText(/\/unsubscribe/, (msg) =>
        this.handleUnsubscribeCommand({ msg, place, bot, telegramBot })
      );
      telegramBot.onText(/\/stop/, (msg) =>
        this.handleUnsubscribeCommand({ msg, place, bot, telegramBot })
      );
      telegramBot.onText(/\/stats/, (msg) =>
        this.handleStatsCommand({ msg, place, bot, telegramBot })
      );
      telegramBot.onText(/\/about/, (msg) =>
        this.handleAboutCommand({ msg, place, bot, telegramBot })
      );
    } catch (e) {
      this.logger.error(
        `[BOT_INIT] Failed to create Telegram bot for ${place.name}: ${e instanceof Error ? e.message : e}`
      );
    }
  }

  public getMainTelegramBotInstance(): TelegramBot | undefined {
    this.logger.log(
      `[getMainTelegramBotInstance] called. Current bot keys: ${JSON.stringify(
        Object.keys(this.placeBots)
      )}`
    );

    const allEntries = Object.entries(this.placeBots).map(([id, entry]) => ({
      id,
      enabled: entry.bot.isEnabled,
      name: entry.bot.botName,
    }));
    this.logger.debug(
      `[getMainTelegramBotInstance] Entries status: ${JSON.stringify(allEntries)}`
    );

    const activeBotEntry = Object.values(this.placeBots).find(
      (entry) => entry.bot.isEnabled
    );

    if (activeBotEntry) {
      this.logger.log(
        `[getMainTelegramBotInstance] Returning bot ${activeBotEntry.bot.botName}`
      );
      return activeBotEntry.telegramBot;
    } else {
      this.logger.warn(
        '[getMainTelegramBotInstance] No active bot instance found — returning undefined.'
      );
      return undefined;
    }
  }

  private async notifyAllPlaceSubscribers(params: {
    readonly place: Place;
    readonly msg: string;
  }): Promise<void> {
    const { place, msg } = params;
    this.logger.log(
      `[NOTIFY] Preparing to notify subscribers for ${place.name} (${place.id})`
    );

    const botEntry = this.placeBots[place.id];
    if (!botEntry) {
      this.logger.warn(
        `[NOTIFY] No bot instance found for ${place.name}, skipping.`
      );
      return;
    }

    if (!botEntry.bot.isEnabled) {
      this.logger.warn(
        `[NOTIFY] Bot for ${place.name} disabled, skipping notifications.`
      );
      return;
    }

    const subscribers = await this.userRepository.getAllPlaceUserSubscriptions({
      placeId: place.id,
    });

    this.logger.log(
      `[NOTIFY] Sending message to ${subscribers.length} subscribers of ${place.name}`
    );

    for (const subscriber of subscribers) {
      const { chatId } = subscriber;
      await this.sleep({ ms: BULK_NOTIFICATION_DELAY_IN_MS });
      botEntry.telegramBot
        .sendMessage(chatId, msg, { parse_mode: 'HTML' })
        .catch((e: any) => {
          if (
            e?.code === 'ETELEGRAM' &&
            e?.message?.includes('403') &&
            (e.message?.includes('blocked by the user') ||
              e.message?.includes('user is deactivated'))
          ) {
            this.logger.warn(
              `[NOTIFY] ${chatId} blocked bot ${botEntry.bot.botName}. Removing subscription.`
            );
            this.userRepository.removeUserSubscription({
              placeId: place.id,
              chatId,
            });
          } else {
            this.logger.error(
              `[NOTIFY] Failed to send to ${chatId}: ${JSON.stringify(e)}`
            );
          }
        });
    }

    this.logger.log(`[NOTIFY] Finished notifying ${place.name}`);
  }
}
