import {
  ElectricityAvailabilityService,
  ScheduleCacheService,
} from '@electrobot/electricity-availability';
// import { UserRepository } from '@electrobot/user-repo'; // <--- ВИДАЛЕНО
import { Cron } from '@nestjs/schedule';
import { Injectable, Logger, OnModuleInit, forwardRef, Inject } from '@nestjs/common';
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
import { PlaceRepository } from '@electrobot/place-repo'; // <--- ЗАЛИШЕНО (для ін'єкції в EA_Service)
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

// --- ІМІТАЦІЯ dt_util ---
const TZ_KYIV = 'Europe/Kyiv';
const dt_util_mock = {
  now: (timeZone: string) => convertToTimeZone(new Date(), { timeZone }),
};
// --- ----------------- ---

const MIN_SUSPICIOUS_DISABLE_TIME_IN_MINUTES = 30;
const BULK_NOTIFICATION_DELAY_IN_MS = 50;


// --- ХАРДКОД ВАШИХ НАЛАШТУВАНЬ (ЗАМІСТЬ БД) ---
const HARDCODED_PLACE: Place = {
    id: "001", // Ваш ID
    name: "дома",
    host: "176.100.14.52", // Ваш IP
    timezone: "Europe/Kyiv",
    isDisabled: false,
    disableMonthlyStats: false,
    // --- Додайте ваші ключі для графіка ---
    scheduleRegionKey: "kyiv", 
    scheduleQueueKey: "2.1" // <--- Вкажіть вашу групу
};

const HARDCODED_BOT: Bot = {
    placeId: "001",
    token: process.env.BOT_TOKEN_001, // <--- Переконайтесь, що ця змінна є на Koyeb!
    botName: "OmniLightBot",
    isEnabled: true
};
// --- ------------------------------------ ---


@Injectable()
export class NotificationBotService implements OnModuleInit {
  private readonly logger = new Logger(NotificationBotService.name);
  
  // --- КЕШІ В ПАМ'ЯТІ ---
  private places: Record<string, Place> = {};
  private placeBots: Record<string, {
      readonly bot: Bot;
      readonly telegramBot: TelegramBot;
    }> = {};
  private subscriberCache: Record<string, number[]> = {}; // { placeId: [chatId1, ...] }
  private warnedOutageSlots = new Set<string>();
  // --- ---------------- ---

  private isRefreshingPlacesAndBots = false;

  constructor(
    @Inject(forwardRef(() => ElectricityAvailabilityService))
    private readonly electricityAvailabilityService: ElectricityAvailabilityService,
    private readonly scheduleCacheService: ScheduleCacheService,
    // --- ВИДАЛЕНО UserRepository та PlaceRepository ---
  ) {
    this.logger.log('>>> Constructor called (DATABASE REPOSITORIES REMOVED)');
    this.logger.log('>>> Constructor finished');
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('>>> ENTERING onModuleInit()');
    this.logger.log('Starting initial refresh from hardcoded config...');
    try {
      // Завантажуємо хардкод при старті
      await this.refreshAllPlacesAndBots();
      this.logger.log('Automatic periodic refresh is DISABLED. Use /update command.');
    } catch (error) {
      this.logger.error(`>>> CRITICAL ERROR inside onModuleInit during initial refresh: ${error}`, error instanceof Error ? error.stack : undefined);
    }
    this.logger.log('>>> EXITING onModuleInit()');
  }

  // --- (Методи для Cron Job та сповіщень: checkUpcomingOutages, sendScrapedNotification, sendBulkNotificationsToPlace) ---
  // --- (вони ЗАЛИШАЮТЬСЯ БЕЗ ЗМІН з попередньої відповіді) ---
  @Cron('*/5 * * * *') 
  async checkUpcomingOutages(): Promise<void> {
    this.logger.log('[WarningCron] Running check for upcoming outages...');
    const now = dt_util_mock.now(TZ_KYIV);
    this.warnedOutageSlots.forEach(slotKey => {
      const timestamp = new Date(slotKey.split('|')[0]);
      if (differenceInMinutes(now, timestamp) > 120) {
        this.warnedOutageSlots.delete(slotKey);
      }
    });

    const PLACE_ID_TO_SCHEDULE = "001";
    const REGION_KEY = "kyiv";
    const QUEUE_KEY = "2.1";
    const place = this.places[PLACE_ID_TO_SCHEDULE];

    if (!place || place.isDisabled) {
        this.logger.debug(`[WarningCron] Place ${PLACE_ID_TO_SCHEDULE} is disabled or not found. Skipping.`);
        return;
    }
    try {
      const prediction = this.scheduleCacheService.getSchedulePrediction(REGION_KEY, QUEUE_KEY);
      const nextOutageTime = prediction.scheduleDisableMoment || prediction.schedulePossibleDisableMoment;
      if (!nextOutageTime) {
        return; 
      }
      const diffInMinutes = differenceInMinutes(nextOutageTime, now);
      if (diffInMinutes >= 55 && diffInMinutes <= 60) {
        const slotKey = `${nextOutageTime.toISOString()}|${place.id}`;
        if (this.warnedOutageSlots.has(slotKey)) {
          this.logger.debug(`[WarningCron] Already warned about ${slotKey}. Skipping.`);
          return;
        }
        this.logger.log(`[WarningCron] Sending warning for place ${place.id}. Outage at ${nextOutageTime.toISOString()}`);
        const timeStr = format(nextOutageTime, 'HH:mm');
        const message = `💡 **Увага!**\n\nЗгідно з графіком, о **${timeStr}** очікується **можливе або гарантоване** відключення світла.\n\n🔋 Не забудьте зарядити ваші пристрої!`;
        await this.sendBulkNotificationsToPlace(place.id, message);
        this.warnedOutageSlots.add(slotKey);
      }
    } catch (error) {
      this.logger.error(`[WarningCron] Error checking warnings for place ${place.id}: ${error}`);
    }
    this.logger.log('[WarningCron] Finished check.');
  }

  public async sendScrapedNotification(message: string): Promise<void> {
    this.logger.log(`[ScrapedNotify] Sending global schedule update: "${message.substring(0, 50)}..."`);
    for (const placeId in this.subscriberCache) {
      const placeSubscribers = this.subscriberCache[placeId];
      if (placeSubscribers && placeSubscribers.length > 0) {
        await this.sendBulkNotificationsToPlace(placeId, message);
      }
    }
    this.logger.log('[ScrapedNotify] Finished sending global schedule update.');
  }

  public async sendBulkNotificationsToPlace(placeId: string, message: string): Promise<void> {
    const botEntry = this.placeBots[placeId];
    const chatIds = this.subscriberCache[placeId]; 
    if (!botEntry?.telegramBot || !botEntry.bot.isEnabled) {
      this.logger.warn(`[BulkNotify] No active bot found for place ${placeId}. Skipping.`);
      return;
    }
    if (!chatIds || chatIds.length === 0) {
      this.logger.debug(`[BulkNotify] No cached subscribers for place ${placeId}. Skipping.`);
      return;
    }
    this.logger.log(`[BulkNotify] Sending message to ${chatIds.length} cached subscribers for place ${placeId}...`);
    let successCount = 0;
    let blockedCount = 0;
    let errorCount = 0;
    const parseMode = 'HTML'; 
    const escapedMessage = message
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>') 
        .replace(/\n/g, '<br>');
    for (const chatId of chatIds) {
      try {
        await this.sleep({ ms: BULK_NOTIFICATION_DELAY_IN_MS });
        await botEntry.telegramBot.sendMessage(chatId, escapedMessage, { parse_mode: parseMode });
        successCount++;
      } catch (e: any) {
        const errorCode = e?.response?.body?.error_code;
        const errorDesc = e?.response?.body?.description || e?.message || JSON.stringify(e);
        if (errorCode === 403 && (errorDesc.includes('blocked') || errorDesc.includes('deactivated'))) {
          this.logger.log(`User ${chatId} blocked bot for place ${placeId}. Removing subscription from Cache.`);
          blockedCount++;
          // --- ВИДАЛЕНО ЗАПИТ ДО БД ---
          // Видаляємо з кешу
          const index = this.subscriberCache[placeId].indexOf(chatId);
          if (index > -1) this.subscriberCache[placeId].splice(index, 1);
        } else {
          errorCount++;
          this.logger.warn(`Failed to send notification to chat ${chatId} (place ${placeId}). Code: ${errorCode}. Desc: ${errorDesc}`);
        }
      }
    }
    this.logger.log(`[BulkNotify] Finished for place ${placeId}. Success: ${successCount}, Blocked: ${blockedCount}, Errors: ${errorCount}`);
  }


  /**
   * ОНОВЛЕНИЙ: Цей метод тепер просто читає хардкод
   */
  private async refreshAllPlacesAndBots(): Promise<void> {
    this.logger.log('>>> ENTERING refreshAllPlacesAndBots()');
    if (this.isRefreshingPlacesAndBots) {
      this.logger.warn('Refresh already in progress, skipping.');
      return;
    }
    this.isRefreshingPlacesAndBots = true;
    this.logger.log('Starting refreshAllPlacesAndBots from hardcoded config...');
    
    try {
      // --- ВИКОРИСТОВУЄМО ХАРДКОД ЗАМІСТЬ БД ---
      const loadedPlaces = [HARDCODED_PLACE];
      const loadedBots = [HARDCODED_BOT];
      // --- ------------------------------- ---

      this.logger.log(`Loaded ${loadedPlaces.length} places from hardcode.`);
      this.places = loadedPlaces.reduce<Record<string, Place>>(
        (res, place) => ({ ...res, [place.id]: place }),
        {}
      );
      this.logger.log(`Loaded ${loadedBots.length} bots configurations from hardcode.`);

      const newPlaceBots: typeof this.placeBots = {};
      const activePlaceIds = new Set<string>();

      // (Логіка створення/оновлення ботів залишається, але без запиту до БД за підписниками)
      for (const botConfig of loadedBots) {
        if (!botConfig.isEnabled || !botConfig.token) {
           this.logger.log(`Bot for place ${botConfig.placeId} is disabled or has no token, skipping.`);
           continue;
        }
        activePlaceIds.add(botConfig.placeId);
        const place = this.places[botConfig.placeId];
        if (!place) {
          this.logger.error(`Place ${botConfig.placeId} (from hardcoded bots) not found in hardcoded places.`);
          continue;
        }
        const existingEntry = this.placeBots[botConfig.placeId];
        if (existingEntry) {
          if(existingEntry.bot.token !== botConfig.token) {
            this.logger.warn(`Token changed for place ${place.id}. Recreating bot instance.`);
            // (Логіка зупинки старого бота...)
            try {
               if (existingEntry.telegramBot && typeof (existingEntry.telegramBot as any).stopPolling === 'function') {
                 await (existingEntry.telegramBot as any).stopPolling({ cancel: true }).catch(stopError => this.logger.error(`Non-critical error stopping previous instance polling for place ${place.id}: ${stopError}`));
               }
               if (existingEntry.telegramBot && typeof (existingEntry.telegramBot as any).close === 'function') {
                   await (existingEntry.telegramBot as any).close().catch(closeError => this.logger.error(`Non-critical error closing previous instance for place ${place.id}: ${closeError}`));
               }
            } catch (stopError) { this.logger.error(`Error stopping/closing previous instance for place ${place.id}: ${stopError}`); }
            // Створюємо новий
            const createdInstance = this.createBot({ place, bot: botConfig });
            if (createdInstance) {
              newPlaceBots[botConfig.placeId] = { bot: botConfig, telegramBot: createdInstance };
            }
          } else {
            // Токен не змінився
            newPlaceBots[botConfig.placeId] = { ...existingEntry, bot: botConfig };
            this.logger.log(`Bot instance for place ${place.id} already exists, config updated.`);
          }
        } else {
          // Створюємо новий
          this.logger.log(`Creating NEW bot instance for place ${place.id}`);
          const createdInstance = this.createBot({ place, bot: botConfig });
          if (createdInstance) {
            newPlaceBots[botConfig.placeId] = { bot: botConfig, telegramBot: createdInstance };
          }
        }
      } // кінець for
      
      // (Логіка зупинки видалених ботів)
      for (const placeId in this.placeBots) {
          if (!activePlaceIds.has(placeId)) {
             this.logger.warn(`Bot for place ${placeId} seems removed from hardcode. Stopping...`);
             // (Логіка зупинки...)
             const instanceToStop = this.placeBots[placeId]?.telegramBot;
             try {
                 if (instanceToStop && typeof (instanceToStop as any).stopPolling === 'function') {
                   await (instanceToStop as any).stopPolling({ cancel: true }).catch(stopError => this.logger.error(`Non-critical error stopping removed/disabled instance polling for place ${placeId}: ${stopError}`));
                 }
                 if (instanceToStop && typeof (instanceToStop as any).close === 'function') {
                   await (instanceToStop as any).close().catch(closeError => this.logger.error(`Non-critical error closing removed/disabled instance for place ${placeId}: ${closeError}`));
                 }
             } catch (stopError) { this.logger.error(`Error stopping/closing removed/disabled instance for place ${placeId}: ${stopError}`); }
          }
      }

      this.placeBots = newPlaceBots;

      // --- !!! ВАЖЛИВО !!! ---
      // Ми більше НЕ завантажуємо підписників з БД.
      // Ми ініціалізуємо кеш, ЯКЩО ВІН ПОРОЖНІЙ.
      // (Якщо бот перезапустився, всі підписники ВТРАЧЕНІ)
      if (Object.keys(this.subscriberCache).length === 0) {
          this.logger.warn('[Cache] Subscriber cache is empty (likely due to restart). Initializing empty cache.');
          for (const placeId of activePlaceIds) {
              this.subscriberCache[placeId] = [];
          }
      } else {
          this.logger.log('[Cache] Subscriber cache already exists in memory. Retaining.');
      }
      // --- ---------------- ---

      this.logger.log(`Finished processing bots configurations. Active instances: ${Object.keys(this.placeBots).length}`);
    } catch (e) {
      this.logger.error(`>>> ERROR inside refreshAllPlacesAndBots: ${e}`, e instanceof Error ? e.stack : undefined);
    } finally {
      this.isRefreshingPlacesAndBots = false;
      this.logger.log('>>> EXITING refreshAllPlacesAndBots()');
    }
  }


  // --- (Методи handleStart, handleCurrent, handleStats, handleAbout - видаляємо userRepository.saveUserAction) ---
  // ... (handleStartCommand - видаліть рядок "await this.userRepository.saveUserAction(...)") ...
  // ... (handleCurrentCommand - видаліть рядок "await this.userRepository.saveUserAction(...)") ...
  // ... (handleStatsCommand - видаліTь рядок "await this.userRepository.saveUserAction(...)") ...
  // ... (handleAboutCommand - видаліTь рядок "await this.userRepository.saveUserAction(...)") ...
  
  // --- ОНОВЛЕНИЙ handleSubscribeCommand ---
  private async handleSubscribeCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    // ... (перевірки msg, place, isDisabled) ...
    if (!msg || !place || !telegramBot) return;
    if (this.isGroup({ chatId: msg.chat.id })) return;
    if (place.isDisabled) { /* ... */ return; }

    try {
      // --- ВИДАЛЕНО saveUserAction ---
      const chatIdNum = Number(msg.chat.id);
      let added = false;
      
      // --- ЛОГІКА РОБОТИ З КЕШЕМ ---
      if (!isNaN(chatIdNum)) {
        if (!this.subscriberCache[place.id]) {
          this.subscriberCache[place.id] = [];
        }
        if (!this.subscriberCache[place.id].includes(chatIdNum)) {
          this.subscriberCache[place.id].push(chatIdNum);
          this.logger.log(`[Cache] Added chat ${chatIdNum} to subscriber cache for place ${place.id}`);
          added = true;
        } else {
           this.logger.log(`[Cache] Chat ${chatIdNum} already in cache for place ${place.id}.`);
           added = false; // Вже існує
        }
      }
      // --- --------------------- ---

      const response = added
        ? RESP_SUBSCRIPTION_CREATED({ place: place.name })
        : RESP_SUBSCRIPTION_ALREADY_EXISTS({ place: place.name });
        
      await telegramBot.sendMessage(msg.chat.id, response, { parse_mode: 'HTML' });
      this.logger.log(`Sent /subscribe response (added=${added}) to chat ${msg.chat.id}`);
    } catch (error) {
      this.logger.error(`Error in handleSubscribeCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined);
    }
  }

  // --- ОНОВЛЕНИЙ handleUnsubscribeCommand ---
  private async handleUnsubscribeCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    // ... (перевірки) ...
    if (!msg || !place || !telegramBot) return;
    if (this.isGroup({ chatId: msg.chat.id })) return;
    
    try {
      // --- ВИДАЛЕНО saveUserAction ---
      const chatIdNum = Number(msg.chat.id);
      let removed = false;

      // --- ЛОГІКА РОБОТИ З КЕШЕМ ---
      if (!isNaN(chatIdNum) && this.subscriberCache[place.id]) {
          const index = this.subscriberCache[place.id].indexOf(chatIdNum);
          if (index > -1) {
              this.subscriberCache[place.id].splice(index, 1);
              this.logger.log(`[Cache] Removed chat ${chatIdNum} from subscriber cache for place ${place.id}`);
              removed = true;
          } else {
              this.logger.log(`[Cache] Chat ${chatIdNum} not found in cache for place ${place.id}.`);
              removed = false; // Не був підписаний
          }
      }
      // --- --------------------- ---

      const response = removed
        ? RESP_UNSUBSCRIBED({ place: place.name })
        : RESP_WAS_NOT_SUBSCRIBED({ place: place.name });
        
      await telegramBot.sendMessage(msg.chat.id, response, { parse_mode: 'HTML' });
      this.logger.log(`Sent /unsubscribe response (removed=${removed}) to chat ${msg.chat.id}`);
    } catch (error) {
      this.logger.error(`Error in handleUnsubscribeCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined);
    }
  }

  // --- ОНОВЛЕНИЙ notifyAllPlaceSubscribers ---
  // (Він викликається з `notifyAllPlaceSubscribersAboutElectricityAvailabilityChange`)
  private async notifyAllPlaceSubscribers(params: {
    readonly place: Place;
    readonly msg: string;
  }): Promise<void> {
    const { place, msg } = params;
    if (!place || !msg) {
      this.logger.error('Missing parameters in notifyAllPlaceSubscribers');
      return;
    }
    
    // --- ВИДАЛЕНО ЗАПИТ ДО БД ---
    // (Ми використовуємо метод sendBulkNotificationsToPlace, 
    // який вже використовує кеш `this.subscriberCache`)
    this.logger.log(`Starting notifyAllPlaceSubscribers for place ${place.id} using cache...`);
    await this.sendBulkNotificationsToPlace(place.id, msg);
  }

  // --- ОНОВЛЕНИЙ composeListedBotsMessage ---
  private async composeListedBotsMessage(): Promise<string> {
      this.logger.log('Composing listed bots message from hardcoded config...');
      // --- ВИДАЛЕНО ЗАПИТ ДО БД ---
      // Повертаємо просту заглушку, оскільки у нас лише 1 бот
      const botName = HARDCODED_BOT.botName;
      const placeName = HARDCODED_PLACE.name;
      const userCount = this.subscriberCache[HARDCODED_PLACE.id]?.length || 0; // Беремо з кешу

      let res = `Наразі сервісом користуються ${userCount} користувачів у 1 боті:\n`;
      res += `@${botName}\n${placeName}: ${userCount} користувачів\n`;
      return res + '\n';
  }

}
