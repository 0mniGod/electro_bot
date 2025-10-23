import {
  ElectricityAvailabilityService,
  // KyivElectricstatusScheduleService, // Закоментовано імпорт
} from '@electrobot/electricity-availability';
import { UserRepository } from '@electrobot/user-repo';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common'; // Додано OnModuleInit
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
export class NotificationBotService implements OnModuleInit { // Додано implements OnModuleInit
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
    // private readonly kyivElectricstatusScheduleService: KyivElectricstatusScheduleService, // Закоментовано ін'єкцію залежності
    private readonly userRepository: UserRepository,
    private readonly placeRepository: PlaceRepository
  ) {
    // Виклик refreshAllPlacesAndBots перенесено в onModuleInit

    this.electricityAvailabilityService.availabilityChange$.subscribe(
      ({ placeId }) => {
        this.notifyAllPlaceSubscribersAboutElectricityAvailabilityChange({
          placeId,
        });
      }
    );
  }

  // Метод життєвого циклу NestJS
  async onModuleInit(): Promise<void> {
    this.logger.log('>>> ENTERING onModuleInit()');
    this.logger.log('onModuleInit called. Starting initial refresh...');
    try {
      await this.refreshAllPlacesAndBots(); // Чекаємо завершення першого оновлення

      // Запускаємо періодичне оновлення ТІЛЬКИ ПІСЛЯ першого успішного
      const refreshRate = 10 * 60 * 1000; // 10 min
      setInterval(() => this.refreshAllPlacesAndBots(), refreshRate);
      this.logger.log(`Periodic refresh scheduled every ${refreshRate / 1000 / 60} minutes.`);
    } catch (error) {
      this.logger.error(`>>> CRITICAL ERROR inside onModuleInit: ${error}`, error instanceof Error ? error.stack : undefined);
    }
  }

  public async notifyAllPlacesAboutPreviousMonthStats(): Promise<void> {
    const allPlaces = Object.values(this.places);

    for (const place of allPlaces) {
      if (place.isDisabled || place.disableMonthlyStats) {
        this.logger.verbose(`Skipping monthly notification for ${place.name}`);
        continue;
      }
      await this.notifyAllPlaceSubscribersAboutPreviousMonthStats({ place });
    }
  }

  private async handleStartCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
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
    this.logger.log(`Handling message: ${JSON.stringify(msg)}`);
    const listedBotsMessage = await this.composeListedBotsMessage();
    await telegramBot.sendMessage(
      msg.chat.id,
      RESP_START({ place: place.name, listedBotsMessage }),
      { parse_mode: 'HTML' }
    );
  }

  private async handleCurrentCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
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
      command: 'current',
    });
    this.logger.log(`Handling message: ${JSON.stringify(msg)}`);
    const [latest] =
      await this.electricityAvailabilityService.getLatestPlaceAvailability({
        placeId: place.id,
        limit: 1,
      });
    if (!latest) {
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
    const howLong = formatDistance(now, changeTime, {
      locale: uk,
      includeSeconds: false,
    });

    let scheduleEnableMoment: Date | undefined;
    let schedulePossibleEnableMoment: Date | undefined;
    let scheduleDisableMoment: Date | undefined;
    let schedulePossibleDisableMoment: Date | undefined;

    // --- Початок закоментованого блоку ---
    /*
    if (place.kyivScheduleGroupId === 0 || place.kyivScheduleGroupId) {
      if (latest.isAvailable) {
        const scheduleData =
          await this.kyivElectricstatusScheduleService.getNextDisableMoment({
            scheduleGroupId: place.kyivScheduleGroupId,
          });
        scheduleDisableMoment = scheduleData?.disableMoment;
        schedulePossibleDisableMoment = scheduleData?.possibleDisableMoment;
      } else {
        const scheduleData =
          await this.kyivElectricstatusScheduleService.getNextEnableMoment({
            scheduleGroupId: place.kyivScheduleGroupId,
          });
        scheduleEnableMoment = scheduleData?.enableMoment;
        schedulePossibleEnableMoment = scheduleData?.possibleEnableMoment;
      }
    }
    */
    // --- Кінець закоментованого блоку ---

    const response = latest.isAvailable
      ? RESP_CURRENTLY_AVAILABLE({
          when,
          howLong,
          place: place.name,
          scheduleDisableMoment, // Буде undefined, бо блок вище закоментовано
          schedulePossibleDisableMoment, // Буде undefined
        })
      : RESP_CURRENTLY_UNAVAILABLE({
          when,
          howLong,
          place: place.name,
          scheduleEnableMoment, // Буде undefined
          schedulePossibleEnableMoment, // Буде undefined
        });

    await telegramBot.sendMessage(msg.chat.id, response, {
      parse_mode: 'HTML',
    });
  }

  private async handleSubscribeCommand(params: { /* ... */ }): Promise<void> { /* ... (код без змін) ... */ }
  private async handleUnsubscribeCommand(params: { /* ... */ }): Promise<void> { /* ... (код без змін) ... */ }
  private async handleStatsCommand(params: { /* ... */ }): Promise<void> { /* ... (код без змін) ... */ }
  private async composePlaceMonthStatsMessage(params: { /* ... */ }): Promise<string> { /* ... (код без змін) ... */ }
  private async handleAboutCommand(params: { /* ... */ }): Promise<void> { /* ... (код без змін) ... */ }

  private async notifyAllPlaceSubscribersAboutElectricityAvailabilityChange(params: {
    readonly placeId: string;
  }): Promise<void> {
    const { placeId } = params;
    const place = this.places[placeId];
    if (!place) {
      this.logger.error(
        `Place ${placeId} not fount in memory cache - skipping subscriber notification`
      );
      return;
    }
    if (place.isDisabled) {
      return;
    }
    const [latest, previous] =
      await this.electricityAvailabilityService.getLatestPlaceAvailability({
        placeId,
        limit: 2,
      });
    if (!latest) {
      this.logger.error(
        `Electricity availability changed event, however no availability data in the repo for ${placeId}`
      );
      return;
    }

    let scheduleEnableMoment: Date | undefined;
    let schedulePossibleEnableMoment: Date | undefined;
    let scheduleDisableMoment: Date | undefined;
    let schedulePossibleDisableMoment: Date | undefined;

    // --- Початок закоментованого блоку ---
    /*
    if (place.kyivScheduleGroupId === 0 || place.kyivScheduleGroupId) {
      if (latest.isAvailable) {
        const scheduleData =
          await this.kyivElectricstatusScheduleService.getNextDisableMoment({
            scheduleGroupId: place.kyivScheduleGroupId,
          });
        scheduleDisableMoment = scheduleData?.disableMoment;
        schedulePossibleDisableMoment = scheduleData?.possibleDisableMoment;
      } else {
        const scheduleData =
          await this.kyivElectricstatusScheduleService.getNextEnableMoment({
            scheduleGroupId: place.kyivScheduleGroupId,
          });
        scheduleEnableMoment = scheduleData?.enableMoment;
        schedulePossibleEnableMoment = scheduleData?.possibleEnableMoment;
      }
    }
    */
    // --- Кінець закоментованого блоку ---

    const latestTime = convertToTimeZone(latest.time, {
      timeZone: place.timezone,
    });
    const when = format(latestTime, 'HH:mm dd.MM', { locale: uk });
    let response: string;
    if (!previous) {
      response = latest.isAvailable
        ? RESP_ENABLED_SHORT({
            when,
            place: place.name,
            scheduleDisableMoment, // undefined
            schedulePossibleDisableMoment, // undefined
          })
        : RESP_DISABLED_SHORT({
            when,
            place: place.name,
            scheduleEnableMoment, // undefined
            schedulePossibleEnableMoment, // undefined
          });
    } else {
      const previousTime = convertToTimeZone(previous.time, {
        timeZone: place.timezone,
      });
      const howLong = formatDistance(latestTime, previousTime, {
        locale: uk,
        includeSeconds: false,
      });
      const diffInMinutes = Math.abs(
        differenceInMinutes(previousTime, latestTime)
      );
      if (latest.isAvailable) {
        response =
          diffInMinutes <= MIN_SUSPICIOUS_DISABLE_TIME_IN_MINUTES
            ? RESP_ENABLED_SUSPICIOUS({ when, place: place.name })
            : RESP_ENABLED_DETAILED({
                when,
                howLong,
                place: place.name,
                scheduleDisableMoment, // undefined
                schedulePossibleDisableMoment, // undefined
              });
      } else {
        response =
          diffInMinutes <= MIN_SUSPICIOUS_DISABLE_TIME_IN_MINUTES
            ? RESP_DISABLED_SUSPICIOUS({ when, place: place.name })
            : RESP_DISABLED_DETAILED({
                when,
                howLong,
                place: place.name,
                scheduleEnableMoment, // undefined
                schedulePossibleEnableMoment, // undefined
              });
      }
    }
    this.notifyAllPlaceSubscribers({
      place,
      msg: response,
    });
  }

  private async notifyAllPlaceSubscribersAboutPreviousMonthStats(params: { /* ... */ }): Promise<void> { /* ... (код без змін) ... */ }
  private async notifyAllPlaceSubscribers(params: { /* ... */ }): Promise<void> { /* ... (код без змін) ... */ }
  private isGroup(params: { readonly chatId: number }): boolean { /* ... (код без змін) ... */ }

  private async refreshAllPlacesAndBots(): Promise<void> {
    this.logger.log('>>> ENTERING refreshAllPlacesAndBots()'); // Додано лог
    if (this.isRefreshingPlacesAndBots) {
      this.logger.warn('Refresh already in progress, skipping.');
      return;
    }
    this.logger.log('Starting refreshAllPlacesAndBots...');
    this.isRefreshingPlacesAndBots = true;
    try {
      const places = await this.placeRepository.getAllPlaces();
      this.logger.log(`Loaded ${places.length} places from DB.`);
      this.places = places.reduce<Record<string, Place>>(
        (res, place) => ({ ...res, [place.id]: place }),
        {}
      );
      const placeBots = await this.placeRepository.getAllPlaceBots();
      this.logger.log(`Loaded ${placeBots.length} bots configurations from DB.`);

      const newPlaceBots: typeof this.placeBots = {};
      for (const botConfig of placeBots) {
        if (!botConfig.isEnabled) {
          this.logger.log(`Bot for place ${botConfig.placeId} is disabled, skipping creation.`);
          continue;
        }
        const place = this.places[botConfig.placeId];
        if (!place) {
          this.logger.error(
            `Place ${botConfig.placeId} not found in memory cache for bot ${botConfig.botName} - cannot create notification bot`
          );
          continue;
        }
        let existingBotInstance = this.placeBots[botConfig.placeId]?.telegramBot;
        if (existingBotInstance) {
          newPlaceBots[botConfig.placeId] = {
            bot: botConfig,
            telegramBot: existingBotInstance,
          };
          this.logger.log(`Bot instance for place ${place.id} already exists, updated config.`);
        } else {
          try {
            const createdInstance = this.createBot({ place, bot: botConfig });
            if (createdInstance) {
              newPlaceBots[botConfig.placeId] = {
                bot: botConfig,
                telegramBot: createdInstance,
              };
            }
          } catch (e) {
            this.logger.error(`Failed to create bot instance for place ${place.id}: ${e}`);
          }
        }
      }
      this.placeBots = newPlaceBots;
      this.logger.log(`Finished refreshing bots. Active instances: ${Object.keys(this.placeBots).length}`);

    } catch (e) {
      this.logger.error(`Error during refreshAllPlacesAndBots: ${e}`, e instanceof Error ? e.stack : undefined);
    } finally {
      this.isRefreshingPlacesAndBots = false;
      this.logger.log('refreshAllPlacesAndBots finished.');
    }
  }

  private createBot(params: {
    readonly place: Place;
    readonly bot: Bot;
  }): TelegramBot | undefined { // <-- Тип повернення змінено
    const { place, bot } = params;
    try {
      this.logger.log(`Attempting to create bot instance for place ${place.id} (${place.name}) with token starting: ${bot.token.substring(0, 10)}...`);
      const telegramBot = new TelegramBot(bot.token); // Без polling: true

      // Обробники подій
      telegramBot.on('polling_error', (error) => {
         this.logger.error(`${place.name}/${bot.botName} internal error (polling_error should not happen with webhooks): ${error}`);
      });
      telegramBot.onText(/\/start/, (msg) => this.handleStartCommand({ msg, place, bot, telegramBot }));
      telegramBot.onText(/\/current/, (msg) => this.handleCurrentCommand({ msg, place, bot, telegramBot }));
      telegramBot.onText(/\/subscribe/, (msg) => this.handleSubscribeCommand({ msg, place, bot, telegramBot }));
      telegramBot.onText(/\/unsubscribe/, (msg) => this.handleUnsubscribeCommand({ msg, place, bot, telegramBot }));
      telegramBot.onText(/\/stop/, (msg) => this.handleUnsubscribeCommand({ msg, place, bot, telegramBot }));
      telegramBot.onText(/\/stats/, (msg) => this.handleStatsCommand({ msg, place, bot, telegramBot }));
      telegramBot.onText(/\/about/, (msg) => this.handleAboutCommand({ msg, place, bot, telegramBot }));

      this.logger.log(`Successfully created bot instance for place ${place.id}.`);
      return telegramBot; // Повертаємо створений екземпляр
    } catch (error) {
       this.logger.error(`Failed during new TelegramBot() for place ${place.id}: ${error}`);
       return undefined; // Повертаємо undefined у разі помилки
    }
  }

  public getMainTelegramBotInstance(): TelegramBot | undefined {
    this.logger.log(`getMainTelegramBotInstance called. Current this.placeBots keys: ${JSON.stringify(Object.keys(this.placeBots))}`);
    const activeBotEntry = Object.values(this.placeBots).find(entry => entry.bot.isEnabled);
    if (activeBotEntry) {
      return activeBotEntry.telegramBot;
    } else {
      this.logger.warn('No active bot instance found in getMainTelegramBotInstance');
      return undefined;
    }
  }

  private async notifyBotDisabled(params: { /* ... */ }): Promise<void> { /* ... (код без змін) ... */ }
  private async sleep(params: { readonly ms: number }): Promise<void> { /* ... (код без змін) ... */ }
}
