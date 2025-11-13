import {
  ElectricityAvailabilityService,
  ScheduleCacheService,
} from '@electrobot/electricity-availability';
// UserRepository та PlaceRepository повністю видалені
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
// import { PlaceRepository } from '@electrobot/place-repo'; // Видалено
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
  // Імпорти для графіків (з messages.constant.ts)
  EXPECTED_DISABLE_MOMENT,
  EXPECTED_ENABLE_MOMENT,
} from './messages.constant';

// --- ІМІТАЦІЯ dt_util ---
const TZ_KYIV = 'Europe/Kiev'; // <--- ВИПРАВЛЕНО
const dt_util_mock = {
  now: (timeZone: string) => convertToTimeZone(new Date(), { timeZone }),
};
// --- ----------------- ---

const MIN_SUSPICIOUS_DISABLE_TIME_IN_MINUTES = 30;
const BULK_NOTIFICATION_DELAY_IN_MS = 50;

// --- ХАРДКОД ВАШИХ НАЛАШТУВАНЬ (ЗАМІСТЬ БД) ---
const HARDCODED_PLACE: Place = {
  id: "001",
  name: "дома",
  checkType: 'ping', // <--- Додано відсутнє поле
  host: "176.100.14.52",
  timezone: "Europe/Kiev", // <--- ВИПРАВЛЕНО
  isDisabled: false,
  disableMonthlyStats: false,
  scheduleRegionKey: "kyiv",
  scheduleQueueKey: "2.1"
};

const HARDCODED_BOT: Bot = {
  id: "bot_001", // <--- Додано відсутнє поле
  placeId: "001",
  token: process.env.BOT_TOKEN_001, // <--- Переконайтесь, що змінна правильна
  botName: "OmniLightBot",
  isEnabled: true,
  isPublicallyListed: false // <--- Додано відсутнє поле
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
    // --- UserRepository та PlaceRepository ВИДАЛЕНО ---
  ) {
    this.logger.log('>>> Constructor called (DATABASE REPOSITORIES REMOVED)');
    this.logger.log('>>> Constructor finished');
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('>>> ENTERING onModuleInit()');
    this.logger.log('Starting initial refresh from hardcoded config...');
    try {
      await this.refreshAllPlacesAndBots(); // Завантажуємо хардкод
      this.logger.log('Automatic periodic refresh is DISABLED. Use /update command.');
    } catch (error) {
      this.logger.error(`>>> CRITICAL ERROR inside onModuleInit during initial refresh: ${error}`, error instanceof Error ? error.stack : undefined);
    }
    this.logger.log('>>> EXITING onModuleInit()');
  }


  // --- (Методи для Cron Job та сповіщень) ---
  
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
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>'); // <--- ВИПРАВЛЕНО (прибрано replace \n)

    for (const chatId of chatIds) {
      try {
        await this.sleep({ ms: BULK_NOTIFICATION_DELAY_IN_MS });
        await botEntry.telegramBot.sendMessage(chatId, escapedMessage, { parse_mode: parseMode });
        successCount++;
      } catch (e: any) {
        const errorCode = e?.response?.body?.error_code;
        const errorDesc = e?.response?.body?.description || e?.message || JSON.stringify(e);

        if (
          errorCode === 403 && 
          (errorDesc.includes('blocked by the user') || errorDesc.includes('user is deactivated'))
        ) {
          this.logger.log(`User ${chatId} blocked bot for place ${placeId}. Removing subscription from Cache.`);
          blockedCount++;
          try {
            const index = this.subscriberCache[placeId].indexOf(chatId); // <--- ВИПРАВЛЕНО
            if (index > -1) this.subscriberCache[placeId].splice(index, 1); // <--- ВИПРАВЛЕНО
          } catch (removeError) {
             this.logger.error(`Failed to remove blocked user ${chatId} from cache for place ${placeId}: ${removeError}`);
          }
        } else {
          errorCount++;
          this.logger.warn(`Failed to send notification to chat ${chatId} (place ${placeId}). Code: ${errorCode}. Desc: ${errorDesc}`);
        }
      }
    }
    this.logger.log(`[BulkNotify] Finished for place ${placeId}. Success: ${successCount}, Blocked: ${blockedCount}, Errors: ${errorCount}`);
  }

  // --- (Метод `notifyAllPlacesAboutPreviousMonthStats` був видалений, оскільки він залежав від БД) ---


  // --- Обробники команд ---

  private async handleStartCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    if (!msg || !place || !telegramBot) return;
    if (this.isGroup({ chatId: msg.chat.id })) return;
    if (place.isDisabled) {
      await this.notifyBotDisabled({ chatId: msg.chat.id, telegramBot });
      return;
    }
    try {
      this.logger.log(`Handling /start message content: ${JSON.stringify(msg)}`);
      const listedBotsMessage = await this.composeListedBotsMessage(); // <--- Тепер працює з кешем
      await telegramBot.sendMessage(
        msg.chat.id,
        RESP_START({ place: place.name, listedBotsMessage }),
        { parse_mode: 'HTML' }
      );
      this.logger.log(`Sent /start response to chat ${msg.chat.id}`);
    } catch (error) {
      this.logger.error(`Error in handleStartCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined);
    }
  }

  private async handleCurrentCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    if (!msg || !place || !telegramBot) return;
    if (this.isGroup({ chatId: msg.chat.id })) return;
    if (place.isDisabled) {
      await this.notifyBotDisabled({ chatId: msg.chat.id, telegramBot });
      return;
    }
    try {
      this.logger.log(`Handling /current message content: ${JSON.stringify(msg)}`);
      
      // 1. Отримуємо актуальний стан з кешу EA_Service
      const [latest] =
        await this.electricityAvailabilityService.getLatestPlaceAvailability({
          placeId: place.id,
          limit: 1,
        });
        
      if (!latest) {
        this.logger.warn(`No latest availability info found for place ${place.id}`);
        await telegramBot.sendMessage(msg.chat.id, RESP_NO_CURRENT_INFO({ place: place.name }), { parse_mode: 'HTML' });
        return;
      }

      this.logger.log(`Latest availability for place ${place.id}: ${JSON.stringify(latest)}`);
      const changeTime = convertToTimeZone(latest.time, { timeZone: place.timezone });
      const now = convertToTimeZone(new Date(), { timeZone: place.timezone });
      const when = format(changeTime, 'd MMMM о HH:mm', { locale: uk });
      const howLong = formatDistance(now, changeTime, {
        locale: uk,
        includeSeconds: false,
      });

      // 2. Отримуємо графік (з хардкодом)
      let scheduleEnableMoment: Date | undefined;
      let schedulePossibleEnableMoment: Date | undefined;
      let scheduleDisableMoment: Date | undefined;
      let schedulePossibleDisableMoment: Date | undefined;
      let todaysScheduleString: string | undefined; // <--- Змінна для повного графіка

      const PLACE_ID_TO_SCHEDULE = "001";
      const REGION_KEY = "kyiv";
      const QUEUE_KEY = "2.1";

      if (place.id === PLACE_ID_TO_SCHEDULE) {
        this.logger.debug(`[Schedule] Getting prediction for hardcoded keys: ${REGION_KEY} / ${QUEUE_KEY}`);
        try {
          const prediction = this.scheduleCacheService.getSchedulePrediction(
            REGION_KEY,
            QUEUE_KEY
          );
          scheduleEnableMoment = prediction.scheduleEnableMoment;
          schedulePossibleEnableMoment = prediction.schedulePossibleEnableMoment;
          scheduleDisableMoment = prediction.scheduleDisableMoment;
          schedulePossibleDisableMoment = prediction.schedulePossibleDisableMoment;
          
          // Отримуємо повний графік
          todaysScheduleString = this.scheduleCacheService.getTodaysScheduleAsText(
            REGION_KEY,
            QUEUE_KEY
          );

        } catch (scheduleError) {
          this.logger.error(`[Schedule] Failed to get prediction: ${scheduleError}`);
        }
      } else {
        this.logger.debug(`[Schedule] Place ${place.id} is not ${PLACE_ID_TO_SCHEDULE}. Skipping prediction.`);
      }

      // 3. Формуємо відповідь
      const response = latest.is_available
        ? RESP_CURRENTLY_AVAILABLE({
            when,
            howLong,
            place: place.name,
            scheduleDisableMoment,
            schedulePossibleDisableMoment,
            todaysSchedule: todaysScheduleString,
            scheduleContextMessage: '', // Не додаємо контекст для /current
          })
        : RESP_CURRENTLY_UNAVAILABLE({
            when,
            howLong,
            place: place.name,
            scheduleEnableMoment,
            schedulePossibleEnableMoment,
            todaysSchedule: todaysScheduleString,
            scheduleContextMessage: '', // Не додаємо контекст для /current
          });
          
      await telegramBot.sendMessage(msg.chat.id, response, { parse_mode: 'HTML' });
      this.logger.log(`Sent /current response to chat ${msg.chat.id}`);
    } catch (error) {
      this.logger.error(`Error in handleCurrentCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined);
    }
  }

  private async handleSubscribeCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    if (!msg || !place || !telegramBot) return;
    if (this.isGroup({ chatId: msg.chat.id })) return;
    if (place.isDisabled) {
      await this.notifyBotDisabled({ chatId: msg.chat.id, telegramBot });
      return;
    }
    
    try {
      this.logger.log(`Handling /subscribe message content: ${JSON.stringify(msg)}`);
      const chatIdNum = Number(msg.chat.id);
      let added = false;
      
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
          added = false;
        }
      }

      const response = added
        ? RESP_SUBSCRIPTION_CREATED({ place: place.name })
        : RESP_SUBSCRIPTION_ALREADY_EXISTS({ place: place.name });
        
      await telegramBot.sendMessage(msg.chat.id, response, { parse_mode: 'HTML' });
      this.logger.log(`Sent /subscribe response (added=${added}) to chat ${msg.chat.id}`);
    } catch (error) {
      this.logger.error(`Error in handleSubscribeCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined);
    }
  }

  private async handleUnsubscribeCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    if (!msg || !place || !telegramBot) return;
    if (this.isGroup({ chatId: msg.chat.id })) return;

    try {
      this.logger.log(`Handling /unsubscribe message content: ${JSON.stringify(msg)}`);
      const chatIdNum = Number(msg.chat.id);
      let removed = false;

      if (!isNaN(chatIdNum) && this.subscriberCache[place.id]) {
          const index = this.subscriberCache[place.id].indexOf(chatIdNum);
          if (index > -1) {
              this.subscriberCache[place.id].splice(index, 1);
              this.logger.log(`[Cache] Removed chat ${chatIdNum} from subscriber cache for place ${place.id}`);
              removed = true;
          } else {
              this.logger.log(`[Cache] Chat ${chatIdNum} not found in cache for place ${place.id}.`);
              removed = false;
          }
      }

      const response = removed
        ? RESP_UNSUBSCRIBED({ place: place.name })
        : RESP_WAS_NOT_SUBSCRIBED({ place: place.name });
        
      await telegramBot.sendMessage(msg.chat.id, response, { parse_mode: 'HTML' });
      this.logger.log(`Sent /unsubscribe response (removed=${removed}) to chat ${msg.chat.id}`);
    } catch (error) {
      this.logger.error(`Error in handleUnsubscribeCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined);
    }
  }

  private async handleStatsCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    if (!msg || !place || !telegramBot) return;
    if (this.isGroup({ chatId: msg.chat.id })) return;
    if (place.isDisabled) {
      await this.notifyBotDisabled({ chatId: msg.chat.id, telegramBot });
      return;
    }
    
    try {
      this.logger.log(`Handling /stats message content: ${JSON.stringify(msg)}`);
      
      // --- ВИКЛИКАЄМО МЕТОД З EA_Service, ЯКИЙ ПРАЦЮЄ З ПАМ'ЯТТЮ ---
      const stats = await this.electricityAvailabilityService.getTodayAndYesterdayStats({
        place,
      });
      // --- --------------------------------------------------- ---
      
      if (!stats || !stats.history) {
        this.logger.error(`Failed to get stats data for place ${place.id}`);
        await telegramBot.sendMessage(msg.chat.id, 'Помилка отримання статистики.', { parse_mode: 'HTML' });
        return;
      }
      this.logger.log(`Stats data for place ${place.id}: ${JSON.stringify(stats)}`);

      let response = '';

      // (Логіка обробки "Вчора")
      if (
        (stats.history.yesterday && stats.history.yesterday.length > 1) ||
        stats.lastStateBeforeYesterday !== undefined
      ) {
        response += `${EMOJ_KISS} Вчора:`;
        if (stats.history.yesterday && stats.history.yesterday.length > 1) {
          const yesterday = stats.history.yesterday;
          // ... (Логіка розрахунку howLongAvailable/howLongUnavailable) ...
          // (Ця логіка залишається, оскільки вона не використовує БД)
          const baseDate = new Date();
          let baseDatePlusAvailable = new Date();
          let baseDatePluesUnavailable = new Date();
          yesterday.forEach(({ start, end, isEnabled }, i) => {
              if (!start || !end) return;
              const s = i === 0 ? convertToTimeZone(start, { timeZone: place.timezone }) : start;
              const e = i === yesterday.length - 1 ? convertToTimeZone(end, { timeZone: place.timezone }) : end;
              let durationInMinutes = 0;
              try {
                 durationInMinutes = Math.abs(differenceInMinutes(new Date(e), new Date(s)));
              } catch (diffError) {
                 this.logger.error(`Error calculating differenceInMinutes for yesterday stats: ${diffError}`);
                 return;
              }
              if (isEnabled) {
                baseDatePlusAvailable = addMinutes(baseDatePlusAvailable, durationInMinutes);
              } else {
                baseDatePluesUnavailable = addMinutes(baseDatePluesUnavailable, durationInMinutes);
              }
          });
          const howLongAvailable = formatDistance(baseDate, baseDatePlusAvailable, { locale: uk, includeSeconds: false });
          const howLongUnavailable = formatDistance(baseDate, baseDatePluesUnavailable, { locale: uk, includeSeconds: false });
          response = `${response}\nЗі світлом: ${howLongAvailable}\nБез світла: ${howLongUnavailable}`;
          
          // ... (Логіка додавання рядків entry) ...
          yesterday.forEach(({ start, end, isEnabled }, i) => {
             if (!start || !end) return;
             const emoji = isEnabled ? EMOJ_BULB : EMOJ_MOON;
             const s = format(new Date(start), 'HH:mm', { locale: uk });
             const e = format(new Date(end), 'HH:mm', { locale: uk });
             const duration = formatDistance(new Date(end), new Date(start), { locale: uk, includeSeconds: false });
             const entry =
               i === 0
                 ? `${emoji} до ${e}`
                 : i === yesterday.length - 1
                 ? `${emoji} з ${s}`
                 : `${emoji} ${s}-${e} (${duration})`;
             response = `${response}\n${entry}`;
           });
        } else {
          response += stats.lastStateBeforeYesterday ? ' постійно зі світлом' : ' взагалі без світла';
        }
      }

      // (Логіка обробки "Сьогодні")
      if (
        (stats.history.today && stats.history.today.length > 1) ||
        stats.lastStateBeforeToday !== undefined
      ) {
        if (response.length > 0) {
          response += '\n\n';
        }
        response += `${EMOJ_KISS_HEART} Сьогодні:`;
        if (stats.history.today && stats.history.today.length > 1) {
           const today = stats.history.today;
           // ... (Логіка розрахунку howLongAvailable/howLongUnavailable) ...
           const baseDate = new Date();
           let baseDatePlusAvailable = new Date();
           let baseDatePluesUnavailable = new Date();
           today.forEach(({ start, end, isEnabled }, i) => {
               if (!start || !end) return;
               const s = i === 0 ? convertToTimeZone(start, { timeZone: place.timezone }) : start;
               const e = i === today.length - 1 ? convertToTimeZone(end, { timeZone: place.timezone }) : end;
               let durationInMinutes = 0;
               try {
                  durationInMinutes = Math.abs(differenceInMinutes(new Date(e), new Date(s)));
               } catch (diffError) {
                  this.logger.error(`Error calculating differenceInMinutes for today stats: ${diffError}`);
                  return;
               }
               if (isEnabled) {
                 baseDatePlusAvailable = addMinutes(baseDatePlusAvailable, durationInMinutes);
               } else {
                 baseDatePluesUnavailable = addMinutes(baseDatePluesUnavailable, durationInMinutes);
               }
           });
           const howLongAvailable = formatDistance(baseDate, baseDatePlusAvailable, { locale: uk, includeSeconds: false });
           const howLongUnavailable = formatDistance(baseDate, baseDatePluesUnavailable, { locale: uk, includeSeconds: false });
           response = `${response}\nЗі світлом: ${howLongAvailable}\nБез світла: ${howLongUnavailable}`;
           
           // ... (Логіка додавання рядків entry) ...
           today.forEach(({ start, end, isEnabled }, i) => {
              if (!start || !end) return;
              const emoji = isEnabled ? EMOJ_BULB : EMOJ_MOON;
              const s = format(new Date(start), 'HH:mm', { locale: uk });
              const e = format(new Date(end), 'HH:mm', { locale: uk });
              const duration = formatDistance(new Date(end), new Date(start), { locale: uk, includeSeconds: false });
              const entry =
                i === 0
                  ? `${emoji} до ${e}`
                  : i === today.length - 1
                  ? `${emoji} з ${s}`
                  : `${emoji} ${s}-${e} (${duration})`;
              response = `${response}\n${entry}`;
            });
        } else {
          response += stats.lastStateBeforeToday ? ' постійно зі світлом' : ' взагалі без світла';
        }
      }

      if (response === '') {
        response = 'Наразі інформація відсутня.';
      }
      response += `\n\n${MSG_DISABLED_REGULAR_SUFFIX}`;

      await telegramBot.sendMessage(msg.chat.id, response, { parse_mode: 'HTML' });
      this.logger.log(`Sent /stats response to chat ${msg.chat.id}`);
    } catch (error) {
      this.logger.error(`Error in handleStatsCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined);
    }
  }

  private async composePlaceMonthStatsMessage(params: {
    readonly place: Place;
    readonly dateFromTargetMonth: Date;
  }): Promise<string> {
    this.logger.log(`Composing monthly stats message for place ${params.place.id}`);
    try {
      const monthStats =
        await this.electricityAvailabilityService.getMonthStats(params);
      if (!monthStats) {
        this.logger.warn(`No monthly stats data found for place ${params.place.id}`);
        return '';
      }
      // ... (решта логіки форматування, вона не використовує БД) ...
      const totalMinutes = monthStats.totalMinutesAvailable + monthStats.totalMinutesUnavailable;
      if (totalMinutes === 0) {
         this.logger.warn(`Total minutes for month stats is zero for place ${params.place.id}`);
         return '';
      }
      const percentAvailable = Math.round((100 * monthStats.totalMinutesAvailable) / totalMinutes);
      const percentUnavailable = 100 - percentAvailable;
      const baseDate = convertToTimeZone(new Date(), { timeZone: params.place.timezone });
      const baseDatePlusAvailable = addMinutes(baseDate, monthStats.totalMinutesAvailable);
      const howLongAvailable = formatDistance(baseDate, baseDatePlusAvailable, { locale: uk, includeSeconds: false });
      const baseDatePlusUnavailable = addMinutes(baseDate, monthStats.totalMinutesUnavailable);
      const howLongUnavailable = formatDistance(baseDate, baseDatePlusUnavailable, { locale: uk, includeSeconds: false });
      const m = getMonth(params.dateFromTargetMonth);
      const mn =
         m === 0 ? 'січні' : m === 1 ? 'лютому' : m === 2 ? 'березні' :
         m === 3 ? 'квітні' : m === 4 ? 'травні' : m === 5 ? 'червні' :
         m === 6 ? 'липні' : m === 7 ? 'серпні' : m === 8 ? 'вересні' :
         m === 9 ? 'жовтні' : m === 10 ? 'листопаді' : 'грудні';
      const result = `У ${mn} ми насолоджувалися світлом ${percentAvailable}% часу (сумарно ${howLongAvailable}) і потерпали від темряви ${percentUnavailable}% часу (сумарно ${howLongUnavailable}).`;
      this.logger.log(`Composed monthly stats message for place ${params.place.id}: "${result.substring(0,50)}..."`);
      return result;
    } catch (error) {
      this.logger.error(`Error composing monthly stats for place ${params.place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
      return '';
    }
  }

  private async handleAboutCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    if (!msg || !place || !telegramBot) return;
    if (this.isGroup({ chatId: msg.chat.id })) return;
    if (place.isDisabled) {
      await this.notifyBotDisabled({ chatId: msg.chat.id, telegramBot });
      return;
    }
    
    try {
      this.logger.log(`Handling /about message content: ${JSON.stringify(msg)}`);
      const listedBotsMessage = await this.composeListedBotsMessage(); // <--- Тепер працює з кешем
      await telegramBot.sendMessage(
        msg.chat.id,
        RESP_ABOUT({ listedBotsMessage }),
        { parse_mode: 'HTML' }
      );
      this.logger.log(`Sent /about response to chat ${msg.chat.id}`);
    } catch (error) {
      this.logger.error(`Error in handleAboutCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined);
    }
  }

  /**
   * ОНОВЛЕНИЙ: Цей метод викликається з ElectricityAvailabilityService
   * і тепер містить всю логіку для генерації повідомлення.
   */
  public async handleElectricityChangeNotification(placeId: string): Promise<void> {
    const place = this.places[placeId];
    if (!place) {
      this.logger.error(`[Notify] Cannot send notification, place ${placeId} not in cache.`);
      return;
    }

    try {
      // --- Отримуємо дані з кешу EA Service ---
      const [latest, previous] =
        await this.electricityAvailabilityService.getLatestPlaceAvailability({
          placeId,
          limit: 2,
        });
      
      if (!latest) {
          this.logger.error(`[Notify] 'latest' state is missing for ${placeId}.`);
          return;
      }
      
      // --- Отримуємо графік (Hardcoded) ---
      let scheduleEnableMoment: Date | undefined;
      let schedulePossibleEnableMoment: Date | undefined;
      let scheduleDisableMoment: Date | undefined;
      let schedulePossibleDisableMoment: Date | undefined;
      let scheduleContextMessage = ''; // <--- Нова змінна для контексту
      const nowKyiv = dt_util_mock.now(TZ_KYIV);

      const PLACE_ID_TO_SCHEDULE = "001"; 
      const REGION_KEY = "kyiv";
      const QUEUE_KEY = "2.1"; 

      if (place.id === PLACE_ID_TO_SCHEDULE) {
        try {
            const prediction = this.scheduleCacheService.getSchedulePrediction(REGION_KEY, QUEUE_KEY);
            scheduleEnableMoment = prediction.scheduleEnableMoment;
            schedulePossibleEnableMoment = prediction.schedulePossibleEnableMoment;
            scheduleDisableMoment = prediction.scheduleDisableMoment;
            schedulePossibleDisableMoment = prediction.schedulePossibleDisableMoment;

            // --- ДОДАЄМО АНАЛІЗ ДЛЯ КОНТЕКСТУ ---
            if (!latest.is_available) {
              // --- СВІТЛО ВИМКНУЛИ ---
              const nextOff = prediction.scheduleDisableMoment || prediction.schedulePossibleDisableMoment;
              if (nextOff) {
                const diffInMinutes = differenceInMinutes(nextOff, nowKyiv); // >0 = вимкнули *до* часу
                
                if (diffInMinutes >= -30 && diffInMinutes <= 30) { // Вчасно (з похибкою 30 хв)
                  scheduleContextMessage = 'Вимкнення відбулося за графіком.';
                } else if (diffInMinutes > 30 && diffInMinutes <= 120) { // Раніше (до 2 годин)
                  scheduleContextMessage = '🤬 Вимкнули раніше графіка. Клята русня!';
                } else if (diffInMinutes > 120) { // Дуже рано
                  scheduleContextMessage = '🚨 Схоже, це екстрене відключення (вимкнули >2 годин до графіка). Клята русня!';
                }
              }
            } else {
              // --- СВІТЛО ВВІМКНУЛИ ---
              const nextOn = prediction.scheduleEnableMoment || prediction.schedulePossibleEnableMoment;
              if (nextOn) {
                const diffInMinutes = differenceInMinutes(nextOn, nowKyiv); // >0 = ввімкнули *до* часу
                
                if (diffInMinutes > 120) { // Дуже рано
                  scheduleContextMessage = '🙏💡 Світло дали БІЛЬШЕ НІЖ НА 2 ГОДИНИ раніше графіка! Слава Богу та Енергетикам!';
                } else if (diffInMinutes > 30) { // Рано
                  scheduleContextMessage = '💡 Світло дали раніше графіка! Слава Енергетикам!';
                } else if (diffInMinutes >= -30 && diffInMinutes <= 30) { // Вчасно
                  scheduleContextMessage = 'Увімкнення відбулося за графіком.';
                }
              }
            }
            // --- КІНЕЦЬ АНАЛІЗУ ДЛЯ КОНТЕКСТУ ---

        } catch (scheduleError) {
             this.logger.error(`[Schedule] Failed to get prediction for notification: ${scheduleError}`);
        }
      }
      // --- ------------------------- ---

      const latestTime = convertToTimeZone(latest.time, { timeZone: place.timezone });
      const when = format(latestTime, 'HH:mm dd.MM', { locale: uk });
      let response: string;

      if (!previous) {
        response = latest.is_available
          ? RESP_ENABLED_SHORT({ when, place: place.name, scheduleDisableMoment, schedulePossibleDisableMoment, scheduleContextMessage })
          : RESP_DISABLED_SHORT({ when, place: place.name, scheduleEnableMoment, schedulePossibleEnableMoment, scheduleContextMessage });
      } else {
        const previousTime = convertToTimeZone(previous.time, { timeZone: place.timezone });
        const howLong = formatDistance(latestTime, previousTime, { locale: uk, includeSeconds: false });
        const diffInMinutes = Math.abs(differenceInMinutes(previousTime, latestTime));

        if (latest.is_available) {
          response =
            diffInMinutes <= MIN_SUSPICIOUS_DISABLE_TIME_IN_MINUTES
              ? RESP_ENABLED_SUSPICIOUS({ when, place: place.name, scheduleContextMessage })
              : RESP_ENABLED_DETAILED({ when, howLong, place: place.name, scheduleDisableMoment, schedulePossibleDisableMoment, scheduleContextMessage });
        } else {
          response =
            diffInMinutes <= MIN_SUSPICIOUS_DISABLE_TIME_IN_MINUTES
              ? RESP_DISABLED_SUSPICIOUS({ when, place: place.name, scheduleContextMessage })
              : RESP_DISABLED_DETAILED({ when, howLong, place: place.name, scheduleEnableMoment, schedulePossibleEnableMoment, scheduleContextMessage });
        }
      }
      
      this.logger.log(`[Notify] Prepared message for ${place.id}: "${response.substring(0, 50)}..."`);
      await this.sendBulkNotificationsToPlace(place.id, response); // Використовуємо наш метод для розсилки з кешу

    } catch (error) {
      this.logger.error(`Error in handleElectricityChangeNotification for place ${placeId}: ${error}`, error instanceof Error ? error.stack : undefined);
    }
  }

  // --- (Метод `notifyAllPlaceSubscribers` був видалений) ---

  private async notifyAllPlaceSubscribersAboutPreviousMonthStats(params: {
    readonly place: Place;
  }): Promise<void> {
    const { place } = params;
    if (!place) {
      this.logger.error('Missing place parameter in notifyAllPlaceSubscribersAboutPreviousMonthStats');
      return;
    }
    this.logger.log(`Starting notifyAllPlaceSubscribersAboutPreviousMonthStats for place ${place.id}`);
    if (place.isDisabled) {
      this.logger.log(`Place ${place.id} is disabled, skipping monthly stats.`);
      return;
    }
    try {
      const dateFromPreviousMonth = addMonths(new Date(), -1);
      const statsMessage = await this.composePlaceMonthStatsMessage({ place, dateFromTargetMonth: dateFromPreviousMonth });
      if (!statsMessage) {
        this.logger.log(`No monthly stats message generated for ${place.name} - skipping subscriber notification`);
        return;
      }
      const response = RESP_PREVIOUS_MONTH_SUMMARY({ statsMessage });
      this.logger.log(`Prepared monthly stats notification for place ${place.id}: "${response.substring(0, 50)}..."`);
      await this.sendBulkNotificationsToPlace(place.id, response);
    } catch (error) {
      this.logger.error(`Error in notifyAllPlaceSubscribersAboutPreviousMonthStats for place ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
    }
  }

  private async notifyAllPlaceSubscribers(params: {
    readonly place: Place;
    readonly msg: string;
  }): Promise<void> {
    const { place, msg } = params;
    if (!place || !msg) {
      this.logger.error('Missing parameters in notifyAllPlaceSubscribers');
      return;
    }
    this.logger.log(`Starting notifyAllPlaceSubscribers for place ${place.id} using cache...`);
    await this.sendBulkNotificationsToPlace(place.id, msg);
  }
  
  private isGroup(params: { readonly chatId: number }): boolean {
    const result = params.chatId < 0;
    return result;
  }

  private async refreshAllPlacesAndBots(): Promise<void> {
    this.logger.log('>>> ENTERING refreshAllPlacesAndBots()');
    if (this.isRefreshingPlacesAndBots) {
      this.logger.warn('Refresh already in progress, skipping.');
      return;
    }
    this.isRefreshingPlacesAndBots = true;
    this.logger.log('Starting refreshAllPlacesAndBots from hardcoded config...');
    
    try {
      const loadedPlaces = [HARDCODED_PLACE];
      const loadedBots = [HARDCODED_BOT];

      this.logger.log(`Loaded ${loadedPlaces.length} places from hardcode.`);
      this.places = loadedPlaces.reduce<Record<string, Place>>(
        (res, place) => ({ ...res, [place.id]: place }),
        {}
      );
      this.logger.log(`Loaded ${loadedBots.length} bots configurations from hardcode.`);

      const newPlaceBots: typeof this.placeBots = {};
      const activePlaceIds = new Set<string>();

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
            try {
               if (existingEntry.telegramBot && typeof (existingEntry.telegramBot as any).stopPolling === 'function') {
                 await (existingEntry.telegramBot as any).stopPolling({ cancel: true }).catch(stopError => this.logger.error(`Non-critical error stopping previous instance polling for place ${place.id}: ${stopError}`));
               }
               if (existingEntry.telegramBot && typeof (existingEntry.telegramBot as any).close === 'function') {
                   await (existingEntry.telegramBot as any).close().catch(closeError => this.logger.error(`Non-critical error closing previous instance for place ${place.id}: ${closeError}`));
               }
            } catch (stopError) { this.logger.error(`Error stopping/closing previous instance for place ${place.id}: ${stopError}`); }
            
            const createdInstance = this.createBot({ place, bot: botConfig });
            if (createdInstance) {
              newPlaceBots[botConfig.placeId] = { bot: botConfig, telegramBot: createdInstance };
            }
          } else {
            newPlaceBots[botConfig.placeId] = { ...existingEntry, bot: botConfig };
            this.logger.log(`Bot instance for place ${place.id} already exists, config updated.`);
          }
        } else {
          this.logger.log(`Creating NEW bot instance for place ${place.id}`);
          const createdInstance = this.createBot({ place, bot: botConfig });
          if (createdInstance) {
            newPlaceBots[botConfig.placeId] = { bot: botConfig, telegramBot: createdInstance };
          }
        }
      } 
      
      for (const placeId in this.placeBots) {
          if (!activePlaceIds.has(placeId)) {
             this.logger.warn(`Bot for place ${placeId} seems removed from hardcode. Stopping...`);
             const instanceToStop = this.placeBots[placeId]?.telegramBot;
             try {
                 if (instanceToStop && typeof (instanceToStop as any).stopPolling === 'function') {
                   await (instanceToStop as any).stopPolling({ cancel: true }).catch(stopError => this.logger.error(`Non-critical error stopping removed/disabled instance polling for place ${place.id}: ${stopError}`));
                 }
                 if (instanceToStop && typeof (instanceToStop as any).close === 'function') {
                   await (instanceToStop as any).close().catch(closeError => this.logger.error(`Non-critical error closing removed/disabled instance for place ${placeId}: ${closeError}`));
                 }
             } catch (stopError) { this.logger.error(`Error stopping/closing removed/disabled instance for place ${placeId}: ${stopError}`); }
          }
      }

      this.placeBots = newPlaceBots;

      if (Object.keys(this.subscriberCache).length === 0) {
          this.logger.warn('[Cache] Subscriber cache is empty (likely due to restart). Initializing empty cache.');
          
          const YOUR_TELEGRAM_CHAT_ID = 229951457; 
          
          for (const placeId of activePlaceIds) {
              if (placeId === HARDCODED_PLACE.id) {
                 this.subscriberCache[placeId] = [YOUR_TELEGRAM_CHAT_ID]; 
                 this.logger.log(`[Cache] Hardcoded admin ${YOUR_TELEGRAM_CHAT_ID} to cache for place ${placeId}.`);
              } else {
                 this.subscriberCache[placeId] = [];
              }
          }
      } else {
          this.logger.log('[Cache] Subscriber cache already exists in memory. Retaining.');
      }

      this.logger.log(`Finished processing bots configurations. Active instances: ${Object.keys(this.placeBots).length}`);
    } catch (e) {
      this.logger.error(`>>> ERROR inside refreshAllPlacesAndBots: ${e}`, e instanceof Error ? e.stack : undefined);
    } finally {
      this.isRefreshingPlacesAndBots = false;
      this.logger.log('>>> EXITING refreshAllPlacesAndBots()');
    }
  }

  private createBot(params: {
    readonly place: Place;
    readonly bot: Bot;
  }): TelegramBot | undefined {
    const { place, bot } = params;
    try {
      this.logger.log(`Attempting to create bot instance for place ${place.id} (${place.name}) with token starting: ${bot.token ? bot.token.substring(0, 10) : 'NO_TOKEN'}...`);
      if (!bot.token) {
        this.logger.error(`Token is missing for bot config of place ${place.id}. Cannot create instance.`);
        return undefined;
      }
      const telegramBot = new TelegramBot(bot.token);
      this.logger.log(`TelegramBot instance created for place ${place.id}. Attaching listeners...`);

      telegramBot.on('polling_error', (error) => { this.logger.error(`${place.name}/${bot.botName} internal polling_error: ${error}`); });
      telegramBot.on('webhook_error', (error: any) => {
        const errorCode = error?.code ? `Code: ${error.code}` : '';
        const errorMessage = error?.message ? error.message : JSON.stringify(error);
        this.logger.error(`${place.name}/${bot.botName} webhook_error: ${errorCode} ${errorMessage}`);
      });
      telegramBot.on('error', (error) => { this.logger.error(`${place.name}/${bot.botName} general error: ${error}`, error instanceof Error ? error.stack : undefined); });

      telegramBot.onText(/\/start/, (msg) => {
        this.logger.debug(`Received /start for place ${place.id} via onText`);
        this.handleStartCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleStartCommand: ${err}`, err instanceof Error ? err.stack : undefined));
      });
      telegramBot.onText(/\/current/, (msg) => {
        this.logger.debug(`Received /current for place ${place.id} via onText`);
        this.handleCurrentCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleCurrentCommand: ${err}`, err instanceof Error ? err.stack : undefined));
      });
      telegramBot.onText(/\/subscribe/, (msg) => {
        this.logger.debug(`Received /subscribe for place ${place.id} via onText`);
        this.handleSubscribeCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleSubscribeCommand: ${err}`, err instanceof Error ? err.stack : undefined));
      });
      telegramBot.onText(/\/unsubscribe/, (msg) => {
        this.logger.debug(`Received /unsubscribe for place ${place.id} via onText`);
        this.handleUnsubscribeCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleUnsubscribeCommand: ${err}`, err instanceof Error ? err.stack : undefined));
      });
      telegramBot.onText(/\/stop/, (msg) => {
        this.logger.debug(`Received /stop for place ${place.id} via onText`);
        this.handleUnsubscribeCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleUnsubscribeCommand (stop): ${err}`, err instanceof Error ? err.stack : undefined));
      });
      telegramBot.onText(/\/stats/, (msg) => {
        this.logger.debug(`Received /stats for place ${place.id} via onText`);
        this.handleStatsCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleStatsCommand: ${err}`, err instanceof Error ? err.stack : undefined));
      });
      telegramBot.onText(/\/about/, (msg) => {
        this.logger.debug(`Received /about for place ${place.id} via onText`);
        this.handleAboutCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleAboutCommand: ${err}`, err instanceof Error ? err.stack : undefined));
      });

      telegramBot.onText(/\/update/, async (msg) => {
          const userId = msg.from?.id;
          const chatId = msg.chat.id;
          this.logger.log(`Received /update command from user ${userId} in chat ${chatId} for place ${place.id}`);

          const ADMIN_USER_ID = "229951457";
          if (String(userId) !== ADMIN_USER_ID) {
            this.logger.warn(`User ${userId} is not authorized to run /update for place ${place.id}.`);
            try {
                await telegramBot.sendMessage(chatId, '❌ У вас недостатньо прав для виконання цієї команди.');
            } catch (replyError) { this.logger.error(`Error sending unauthorized message for /update: ${replyError}`); }
            return;
          }
          try {
              await telegramBot.sendMessage(chatId, '🔄 Запускаю оновлення конфігурацій та внутрішнього кешу...');
              await this.refreshAllPlacesAndBots();
              await this.electricityAvailabilityService.refreshInternalCache();
              await telegramBot.sendMessage(chatId, '✅ Оновлення завершено!');
              this.logger.log(`/update command processed successfully for place ${place.id}`);
          } catch (error) {
              this.logger.error(`Error during /update command processing for place ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
              try {
                  await telegramBot.sendMessage(chatId, '❌ Помилка під час оновлення. Перевірте логи.');
              } catch (replyError) { this.logger.error(`Error sending error message for /update: ${replyError}`); }
          }
      });
      
      telegramBot.onText(/\/schedule/, async (msg) => {
          const userId = msg.from?.id;
          const chatId = msg.chat.id;
          this.logger.log(`Received /schedule command from user ${userId} in chat ${chatId} for place ${place.id}`);

          // (Тут також варто додати перевірку на адміна)
          // ...

          try {
              await telegramBot.sendMessage(chatId, '🔄 Запускаю завантаження графіків з API (svitlo-proxy)...');
              
              const success = await this.scheduleCacheService.fetchAndCacheSchedules();

              if (success) {
                  this.logger.log(`[ScheduleCommand] Fetch successful. Generating schedule text for chat ${chatId}.`);
                  
                  const PLACE_ID_TO_SCHEDULE = "001"; 
                  const REGION_KEY = "kyiv";
                  const QUEUE_KEY = "2.1"; 
                  
                  let scheduleTodayString = "<i>Графік на сьогодні не знайдено.</i>";
                  let scheduleTomorrowString = "<i>Графік на завтра не знайдено.</i>"; 

                  if (place.id === PLACE_ID_TO_SCHEDULE) {
                      try {
                          scheduleTodayString = this.scheduleCacheService.getTodaysScheduleAsText(
                              REGION_KEY,
                              QUEUE_KEY
                          );
                          scheduleTomorrowString = this.scheduleCacheService.getTomorrowsScheduleAsText(
                              REGION_KEY,
                              QUEUE_KEY
                          );
                      } catch (e) {
                          this.logger.error(`[ScheduleCommand] Error generating schedule text: ${e}`);
                          scheduleTodayString = "<i>Помилка при генерації графіка.</i>";
                          scheduleTomorrowString = "<i>Помилка при генерації графіка.</i>";
                      }
                  }
                  
                  const responseMessage = `✅ Графіки успішно оновлено.\n\n` +
                                        `<b>--- Графік на сьогодні ---</b>\n` +
                                        `${scheduleTodayString}\n\n` +
                                        `<b>--- Графік на завтра ---</b>\n` +
                                        `${scheduleTomorrowString}`;

                  await telegramBot.sendMessage(chatId, responseMessage, { parse_mode: 'HTML' });
                  
                  this.logger.log(`/schedule command processed successfully for place ${place.id}`);
              } else {
                  await telegramBot.sendMessage(chatId, '❌ Не вдалося завантажити графіки. API (svitlo-proxy) не відповідає.');
                  this.logger.warn(`/schedule command FAILED for place ${place.id} (API error).`);
              }
          } catch (error) {
              this.logger.error(`Error during /schedule command processing for place ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
              await telegramBot.sendMessage(chatId, '❌ Сталася внутрішня помилка. Перевірте логи.');
          }
      });

      this.logger.log(`Successfully created bot instance and attached listeners for place ${place.id}.`); 
      return telegramBot;
    } catch (error) {
       this.logger.error(`>>> FAILED during new TelegramBot() or attaching listeners for place ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined); 
       return undefined;
    }
  }
  
  public getMainTelegramBotInstance(): TelegramBot | undefined {
    this.logger.log(`getMainTelegramBotInstance called. Current this.placeBots keys: ${JSON.stringify(Object.keys(this.placeBots))}`);
    
    const botEntry = this.placeBots[HARDCODED_PLACE.id]; 

    if (botEntry && botEntry.bot.isEnabled) {
      this.logger.log(`Found active bot instance for placeId: ${botEntry.bot.placeId}`);
      return botEntry.telegramBot;
    } else {
      this.logger.warn('No active bot instance found in this.placeBots during getMainTelegramBotInstance');
      return undefined;
    }
  }
  private async notifyBotDisabled(params: {
    readonly chatId: number;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { chatId, telegramBot } = params;
    if (!chatId || !telegramBot) {
      this.logger.error('Missing parameters in notifyBotDisabled');
      return;
    }
    try {
      this.logger.log(`Sending MSG_DISABLED to chat ${chatId}`);
      await telegramBot.sendMessage(chatId, MSG_DISABLED, { parse_mode: 'HTML' });
    } catch (error) {
      this.logger.error(`Error sending MSG_DISABLED to chat ${chatId}: ${error}`);
    }
  }

private async sleep(params: { readonly ms: number }): Promise<void> {
    if (params?.ms > 0) {
      return new Promise((r) => setTimeout(r, params.ms));
    } else {
      return Promise.resolve();
    }
  }
} // <-- Кінець класу NotificationBotService
