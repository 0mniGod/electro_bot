import {
  ElectricityAvailabilityService,
  ScheduleCacheService
  // KyivElectricstatusScheduleService, // Закоментовано імпорт
} from '@electrobot/electricity-availability';
import { UserRepository } from '@electrobot/user-repo';
import { Cron } from '@nestjs/schedule';
// Додаємо OnModuleInit до імпортів з @nestjs/common
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

const TZ_KYIV = 'Europe/Kiev';
const dt_util_mock = {
  now: (timeZone: string) => convertToTimeZone(new Date(), { timeZone }),
};

// --- ----------------- ---

const MIN_SUSPICIOUS_DISABLE_TIME_IN_MINUTES = 30;
const BULK_NOTIFICATION_DELAY_IN_MS = 50;

const HARDCODED_PLACE: Place = {
  id: "001",
  name: "дома",
  checkType: 'ping',
  host: "176.100.14.52",
  timezone: "Europe/Kiev",
  isDisabled: false,
  disableMonthlyStats: false,
  scheduleRegionKey: "kyiv",
  scheduleQueueKey: "2.1"
};

const HARDCODED_BOT: Bot = {
  id: "bot_001",
  placeId: "001",
  token: process.env.BOT_TOKEN,
  botName: "OmniLightBot",
  isEnabled: true,
  isPublicallyListed: false
};


@Injectable()
// Додаємо implements OnModuleInit до класу
export class NotificationBotService implements OnModuleInit {
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

  private subscriberCache: Record<string, number[]> = {};

  constructor(
    @Inject(forwardRef(() => ElectricityAvailabilityService)) // <-- ВИПРАВЛЕНО
    private readonly electricityAvailabilityService: ElectricityAvailabilityService,
    private readonly scheduleCacheService: ScheduleCacheService
  ) {
    this.logger.log('>>> Constructor called');

    // Блок availabilityChange$.subscribe() видалено,
    // оскільки Cron тепер напряму викликає check та handleAvailabilityChange

    this.logger.log('>>> Constructor finished');
  }

  // --- ДОДАНО МЕТОД onModuleInit ---
  // --- ДОДАНО МЕТОД onModuleInit ---
  async onModuleInit(): Promise<void> {
    this.logger.log('>>> ENTERING onModuleInit()'); // Лог входу в метод
    this.logger.log('Starting initial refresh...');
    try {
      // Перше оновлення при старті (ЗАЛИШАЄТЬСЯ)
      await this.refreshAllPlacesAndBots();

      // --- ВИДАЛЕНО АБО ЗАКОМЕНТОВАНО БЛОК setInterval ---
      /*
      const refreshRate = 10 * 60 * 1000; // 10 min
      if (!(global as any).botRefreshInterval) {
           (global as any).botRefreshInterval = setInterval(() => {
               this.logger.log('>>> Interval triggered: calling refreshAllPlacesAndBots()');
               this.refreshAllPlacesAndBots().catch(err => {
                   this.logger.error(`Error during scheduled refreshAllPlacesAndBots: ${err}`, err instanceof Error ? err.stack : undefined);
               });
           }, refreshRate);
           this.logger.log(`Periodic refresh scheduled every ${refreshRate / 1000 / 60} minutes.`);
       } else {
           this.logger.warn('Periodic refresh interval already set.');
       }
      */
      this.logger.log('Automatic periodic refresh is now DISABLED. Use /update command.'); // Додали лог
      // --- КІНЕЦЬ ЗМІН ---

    } catch (error) {
      this.logger.error(`>>> CRITICAL ERROR inside onModuleInit during initial refresh: ${error}`, error instanceof Error ? error.stack : undefined);
    }
    this.logger.log('>>> EXITING onModuleInit()'); // Лог виходу з методу
  }
  // ------------------------------------

  // Властивість для кешування, щоб не надсилати попередження повторно
  private warnedOutageSlots = new Set<string>(); // Зберігає "timestamp|placeId"

  /**
   * (Вимога 4) CRON JOB: Перевіряє кожні 5 хвилин, чи не очікується
   * відключення світла (за 55-60 хвилин)
   */
  @Cron('*/5 * * * *') // Кожні 5 хвилин
  async checkUpcomingOutages(): Promise<void> {
    this.logger.log('[WarningCron] Running check for upcoming outages...');

    const now = dt_util_mock.now(TZ_KYIV); // Використовуємо наш імітований dt_util

    // Очищуємо старі попередження з кешу
    this.warnedOutageSlots.forEach(slotKey => {
      const timestamp = new Date(slotKey.split('|')[0]);
      if (differenceInMinutes(now, timestamp) > 120) { // Видаляємо, якщо старше 2 годин
        this.warnedOutageSlots.delete(slotKey);
      }
    });

    // --- Жорстко вказуємо наші ключі (як ми домовились, без БД) ---
    const PLACE_ID_TO_SCHEDULE = "001"; // ID вашого місця
    const REGION_KEY = "kyiv";
    const QUEUE_KEY = "2.1"; // Ваша група
    // --- ---------------------------------------------------- ---

    // Отримуємо об'єкт "місце" з кешу (який завантажується при старті)
    const place = this.places[PLACE_ID_TO_SCHEDULE];

    // Перевіряємо, чи існує це місце і чи воно активне
    if (!place || place.isDisabled) {
      this.logger.debug(`[WarningCron] Place ${PLACE_ID_TO_SCHEDULE} is disabled or not found. Skipping.`);
      return;
    }

    try {
      // Отримуємо графік з кешу
      const prediction = this.scheduleCacheService.getSchedulePrediction(
        REGION_KEY,
        QUEUE_KEY
      );

      // Нас цікавить або гарантоване вимкнення (2), або можливе (0)
      const nextOutageTime = prediction.scheduleDisableMoment || prediction.schedulePossibleDisableMoment;

      if (!nextOutageTime) {
        // this.logger.debug(`[WarningCron] No upcoming outages found for ${PLACE_ID_TO_SCHEDULE}.`);
        return; // Графік є, але вимкнень не заплановано
      }

      const diffInMinutes = differenceInMinutes(nextOutageTime, now);

      // --- Логіка попередження: за 60-55 хвилин до події ---
      if (diffInMinutes >= 55 && diffInMinutes <= 60) {

        const slotKey = `${nextOutageTime.toISOString()}|${place.id}`;

        // Перевіряємо, чи ми вже не попереджали про цей слот
        if (this.warnedOutageSlots.has(slotKey)) {
          this.logger.debug(`[WarningCron] Already warned about ${slotKey}. Skipping.`);
          return; // Вже попереджали
        }

        // Попереджаємо!
        this.logger.log(`[WarningCron] Sending warning for place ${place.id}. Outage at ${nextOutageTime.toISOString()}`);

        const timeStr = format(nextOutageTime, 'HH:mm');
        const message = `💡 **Увага!**\n\nЗгідно з графіком, о **${timeStr}** очікується **можливе або гарантоване** відключення світла.\n\n🔋 Не забудьте зарядити ваші пристрої!`;

        // Використовуємо кеш підписників
        await this.sendBulkNotificationsToPlace(place.id, message);

        // Додаємо в кеш, щоб не повторювати
        this.warnedOutageSlots.add(slotKey);
      }

    } catch (error) {
      this.logger.error(`[WarningCron] Error checking warnings for place ${place.id}: ${error}`);
    }

    this.logger.log('[WarningCron] Finished check.');
  }


  /**
   * (Вимога 1) Надсилає повідомлення про оновлення ГРАФІКУ всім підписникам
   * УСІХ активних ботів. Використовує кеш підписників.
   */
  public async sendScrapedNotification(message: string): Promise<void> {
    this.logger.log(`[ScrapedNotify] Sending global schedule update: "${message.substring(0, 50)}..."`);

    // Ітеруємо по всіх місцях, для яких є кеш підписників
    for (const placeId in this.subscriberCache) {
      const placeSubscribers = this.subscriberCache[placeId];
      if (placeSubscribers && placeSubscribers.length > 0) {
        await this.sendBulkNotificationsToPlace(placeId, message);
      }
    }
    this.logger.log('[ScrapedNotify] Finished sending global schedule update.');
  }

  /**
   * (Вимога 4) Надсилає повідомлення (напр. попередження) підписникам
   * КОНКРЕТНОГО місця, використовуючи кеш.
   * Цей метод є публічним, щоб його міг викликати WarningCron
   */
  public async sendBulkNotificationsToPlace(placeId: string, message: string): Promise<void> {
    const botEntry = this.placeBots[placeId];
    const chatIds = this.subscriberCache[placeId]; // <--- Беремо з кешу

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

    // Використовуємо HTML, оскільки повідомлення містить форматування
    const parseMode = 'HTML';
    // Проста заміна Markdown-подібного ** на HTML <b>
    const escapedMessage = message
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');

    for (const chatId of chatIds) {
      try {
        await this.sleep({ ms: BULK_NOTIFICATION_DELAY_IN_MS }); // Невелика затримка
        await botEntry.telegramBot.sendMessage(chatId, escapedMessage, { parse_mode: parseMode });
        successCount++;
      } catch (e: any) {

        // --- ПОЧАТОК ЗМІНЕНОГО БЛОКУ CATCH ---
        const errorCode = e?.response?.body?.error_code;
        const errorDesc = e?.response?.body?.description || e?.message || JSON.stringify(e);

        // Повертаємо реальну умову (замість "/* ... */")
        if (
          errorCode === 403 &&
          (errorDesc.includes('blocked by the user') || errorDesc.includes('user is deactivated'))
        ) {
          // Використовуємо 'placeId' (з параметрів функції), а не 'place.id'
          this.logger.log(`User ${chatId} blocked bot for place ${placeId}. Removing subscription from Cache.`);
          blockedCount++;
          try {
            // Видаляємо з кешу
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

  // --- КІНЕЦЬ БЛОКУ ---

  public async notifyAllPlacesAboutPreviousMonthStats(): Promise<void> {
    const allPlaces = Object.values(this.places);
    this.logger.log(`Starting notifyAllPlacesAboutPreviousMonthStats for ${allPlaces.length} places.`); // Лог
    for (const place of allPlaces) {
      if (!place || place.isDisabled || place.disableMonthlyStats) { // Додано перевірку на place
        this.logger.verbose(`Skipping monthly notification for ${place?.name || 'unknown place'} (isDisabled: ${place?.isDisabled}, disableMonthlyStats: ${place?.disableMonthlyStats})`);
        continue;
      }
      try { // Додано try...catch
        await this.notifyAllPlaceSubscribersAboutPreviousMonthStats({ place });
      } catch (error) {
        this.logger.error(`Error sending monthly stats for place ${place?.id || 'unknown id'}: ${error}`); // Лог помилки
      }
    }
    this.logger.log(`Finished notifyAllPlacesAboutPreviousMonthStats.`); // Лог
  }

  private async handleStartCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    // Додаємо перевірку на null/undefined
    if (!msg || !place || !telegramBot) {
      this.logger.error('Missing parameters in handleStartCommand');
      return;
    }
    this.logger.log(`Handling /start command for chat ${msg.chat.id} in place ${place.id}`); // Лог
    if (this.isGroup({ chatId: msg.chat.id })) {
      this.logger.warn(`Skipping group message: ${JSON.stringify(msg)}`);
      return;
    }
    if (place.isDisabled) {
      await this.notifyBotDisabled({ chatId: msg.chat.id, telegramBot });
      return;
    }
    try {
      this.logger.log(`Handling /start message content: ${JSON.stringify(msg)}`); // Додатковий лог
      const listedBotsMessage = "";
      await telegramBot.sendMessage(
        msg.chat.id,
        RESP_START({ place: place.name, listedBotsMessage }),
        { parse_mode: 'HTML' }
      );
      this.logger.log(`Sent /start response to chat ${msg.chat.id}`); // Лог відправки
    } catch (error) {
      this.logger.error(`Error in handleStartCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
    }
  }

  private async handleCurrentCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    // Додаємо перевірку на null/undefined
    if (!msg || !place || !telegramBot) {
      this.logger.error('Missing parameters in handleCurrentCommand');
      return;
    }
    this.logger.log(`Handling /current command for chat ${msg.chat.id} in place ${place.id}`); // Лог
    if (this.isGroup({ chatId: msg.chat.id })) {
      this.logger.warn(`Skipping group message: ${JSON.stringify(msg)}`);
      return;
    }
    if (place.isDisabled) {
      await this.notifyBotDisabled({ chatId: msg.chat.id, telegramBot });
      return;
    }
    try {
      this.logger.log(`Handling /current message content: ${JSON.stringify(msg)}`); // Додатковий лог
      const [latest] =
        await this.electricityAvailabilityService.getLatestPlaceAvailability({
          placeId: place.id,
          limit: 1,
        });
      if (!latest) {
        this.logger.warn(`No latest availability info found for place ${place.id}`); // Лог
        await telegramBot.sendMessage(
          msg.chat.id,
          RESP_NO_CURRENT_INFO({ place: place.name }),
          { parse_mode: 'HTML' }
        );
        return;
      }
      this.logger.log(`Latest availability for place ${place.id}: ${JSON.stringify(latest)}`); // Лог даних
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
      let todaysSchedule: string | undefined; // <--- ДОДАНО
      let tomorrowsSchedule: string | undefined; // <--- ДОДАНО

      // --- Жорстко вказуємо наші ключі ---
      // (Переконайтеся, що "001" - це ID вашого місця "дома")
      const PLACE_ID_TO_SCHEDULE = "001";
      const REGION_KEY = "kyiv";
      const QUEUE_KEY = "2.1"; // <--- Або ваша група

      // Перевіряємо, чи поточне місце - це те, для якого ми знаємо графік
      if (place.id === PLACE_ID_TO_SCHEDULE) {
        this.logger.debug(`[Schedule] Getting prediction for hardcoded keys: ${REGION_KEY} / ${QUEUE_KEY}`);
        try {
          // Викликаємо наш сервіс кешу з "зашитими" ключами
          const prediction = this.scheduleCacheService.getSchedulePrediction(
            REGION_KEY,
            QUEUE_KEY
          );

          // Призначаємо отримані значення
          scheduleEnableMoment = prediction.scheduleEnableMoment;
          schedulePossibleEnableMoment = prediction.schedulePossibleEnableMoment;
          scheduleDisableMoment = prediction.scheduleDisableMoment;
          schedulePossibleDisableMoment = prediction.schedulePossibleDisableMoment;

          // --- ОТРИМУЄМО ТЕКСТ ГРАФІКІВ ---
          todaysSchedule = this.scheduleCacheService.getTodaysScheduleAsText(REGION_KEY, QUEUE_KEY);
          tomorrowsSchedule = this.scheduleCacheService.getTomorrowsScheduleAsText(REGION_KEY, QUEUE_KEY);
          // --- ------------------------ ---

        } catch (scheduleError) {
          this.logger.error(`[Schedule] Failed to get prediction: ${scheduleError}`);
        }
      } else {
        this.logger.debug(`[Schedule] Place ${place.id} is not ${PLACE_ID_TO_SCHEDULE}. Skipping prediction.`);
      }

      const response = latest.is_available
        ? RESP_CURRENTLY_AVAILABLE({
          when,
          howLong,
          place: place.name,
          scheduleDisableMoment,
          schedulePossibleDisableMoment,
          todaysSchedule, // <--- ДОДАНО
          tomorrowsSchedule, // <--- ДОДАНО
        })
        : RESP_CURRENTLY_UNAVAILABLE({
          when,
          howLong,
          place: place.name,
          scheduleEnableMoment,
          schedulePossibleEnableMoment,
          todaysSchedule, // <--- ДОДАНО
          tomorrowsSchedule, // <--- ДОДАНО
        });
      await telegramBot.sendMessage(msg.chat.id, response, {
        parse_mode: 'HTML',
      });
      this.logger.log(`Sent /current response to chat ${msg.chat.id}`); // Лог відправки
    } catch (error) {
      this.logger.error(`Error in handleCurrentCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
    }
  }

  private async handleSubscribeCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    // Додаємо перевірку на null/undefined
    if (!msg || !place || !telegramBot) {
      this.logger.error('Missing parameters in handleSubscribeCommand');
      return;
    }
    this.logger.log(`Handling /subscribe command for chat ${msg.chat.id} in place ${place.id}`); // Лог
    if (this.isGroup({ chatId: msg.chat.id })) {
      this.logger.warn(`Skipping group message: ${JSON.stringify(msg)}`);
      return;
    }
    if (place.isDisabled) {
      await this.notifyBotDisabled({ chatId: msg.chat.id, telegramBot });
      return;
    }
    try {
      // --- ВИДАЛЕНО saveUserAction ---
      this.logger.log(`Handling /subscribe message content: ${JSON.stringify(msg)}`);

      const chatIdNum = Number(msg.chat.id);
      let added = false;

      // --- ЛОГІКА РОБОТИ З КЕШЕМ (ЗАМІСТЬ ЗАПИТУ ДО БД) ---
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
      // --- -------------------------------------------- ---

      const response = added
        ? RESP_SUBSCRIPTION_CREATED({ place: place.name })
        : RESP_SUBSCRIPTION_ALREADY_EXISTS({ place: place.name });

      await telegramBot.sendMessage(msg.chat.id, response, { parse_mode: 'HTML' });

      this.logger.log(`Sent /subscribe response (added=${added}) to chat ${msg.chat.id}`); // Лог відправки
    } catch (error) {
      this.logger.error(`Error in handleSubscribeCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
    }
  }

  private async handleUnsubscribeCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    // Додаємо перевірку на null/undefined
    if (!msg || !place || !telegramBot) {
      this.logger.error('Missing parameters in handleUnsubscribeCommand');
      return;
    }
    this.logger.log(`Handling /unsubscribe command for chat ${msg.chat.id} in place ${place.id}`); // Лог
    if (this.isGroup({ chatId: msg.chat.id })) {
      this.logger.warn(`Skipping group message: ${JSON.stringify(msg)}`);
      return;
    }
    try {
      // --- ВИДАЛЕНО saveUserAction ---
      this.logger.log(`Handling /unsubscribe message content: ${JSON.stringify(msg)}`);

      const chatIdNum = Number(msg.chat.id);
      let removed = false;

      // --- ЛОГІКА РОБОТИ З КЕШЕМ (ЗАМІСТЬ ЗАПИТУ ДО БД) ---
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
      // --- -------------------------------------------- ---

      const response = removed
        ? RESP_UNSUBSCRIBED({ place: place.name })
        : RESP_WAS_NOT_SUBSCRIBED({ place: place.name });

      await telegramBot.sendMessage(msg.chat.id, response, { parse_mode: 'HTML' });

      this.logger.log(`Sent /unsubscribe response (removed=${removed}) to chat ${msg.chat.id}`); // Лог відправки
    } catch (error) {
      this.logger.error(`Error in handleUnsubscribeCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
    }
  }

  // TODO: refactor (make cleaner)
  private async handleStatsCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    // Додаємо перевірку на null/undefined
    if (!msg || !place || !telegramBot) {
      this.logger.error('Missing parameters in handleStatsCommand');
      return;
    }
    this.logger.log(`Handling /stats command for chat ${msg.chat.id} in place ${place.id}`); // Лог
    if (this.isGroup({ chatId: msg.chat.id })) {
      this.logger.warn(`Skipping group message: ${JSON.stringify(msg)}`);
      return;
    }
    if (place.isDisabled) {
      await this.notifyBotDisabled({ chatId: msg.chat.id, telegramBot });
      return;
    }
    try {
      this.logger.log(`Handling /stats message content: ${JSON.stringify(msg)}`); // Додатковий лог
      const stats = await this.electricityAvailabilityService.getTodayAndYesterdayStats({
        place,
      });
      // Перевірка на null/undefined для stats
      if (!stats || !stats.history) {
        this.logger.error(`Failed to get stats data for place ${place.id}`);
        await telegramBot.sendMessage(msg.chat.id, 'Помилка отримання статистики.', { parse_mode: 'HTML' });
        return;
      }
      this.logger.log(`Stats data for place ${place.id}: ${JSON.stringify(stats)}`); // Лог статистики

      let response = '';

      // Вчорашня статистика
      if (
        (stats.history.yesterday && // Додано перевірку
          stats.history.yesterday.length > 1) ||
        stats.lastStateBeforeYesterday !== undefined
      ) {
        response += `${EMOJ_KISS} Вчора:`;

        if (
          stats.history.yesterday && // Додано перевірку
          stats.history.yesterday.length > 1
        ) {
          const yesterday = stats.history.yesterday;

          const baseDate = new Date();
          let baseDatePlusAvailable = new Date();
          let baseDatePluesUnavailable = new Date();

          yesterday.forEach(({ start, end, isEnabled }, i) => {
            // Додаємо перевірку на start/end
            if (!start || !end) return;
            const s =
              i === 0
                ? convertToTimeZone(start, { timeZone: place.timezone })
                : start;
            const e =
              i === yesterday.length - 1
                ? convertToTimeZone(end, { timeZone: place.timezone })
                : end;
            // Виправлено: різниця має бути між end та start, і обережно з типами
            let durationInMinutes = 0;
            try {
              durationInMinutes = Math.abs(differenceInMinutes(new Date(e), new Date(s)));
            } catch (diffError) {
              this.logger.error(`Error calculating differenceInMinutes for yesterday stats: ${diffError}`);
              return; // Пропускаємо цей запис, якщо дати невалідні
            }


            if (isEnabled) {
              baseDatePlusAvailable = addMinutes(
                baseDatePlusAvailable,
                durationInMinutes
              );
            } else {
              baseDatePluesUnavailable = addMinutes(
                baseDatePluesUnavailable,
                durationInMinutes
              );
            }
          });

          const howLongAvailable = formatDistance(
            baseDate, // Змінено порядок аргументів для коректного відображення
            baseDatePlusAvailable,
            { locale: uk, includeSeconds: false }
          );
          const howLongUnavailable = formatDistance(
            baseDate, // Змінено порядок аргументів
            baseDatePluesUnavailable,
            { locale: uk, includeSeconds: false }
          );

          response = `${response}\nЗі світлом: ${howLongAvailable}\nБез світла: ${howLongUnavailable}`;

          yesterday.forEach(({ start, end, isEnabled }, i) => {
            // Додаємо перевірку на start/end
            if (!start || !end) return;
            const emoji = isEnabled ? EMOJ_BULB : EMOJ_MOON;
            const s = format(new Date(start), 'HH:mm', { locale: uk }); // Додано new Date()
            const e = format(new Date(end), 'HH:mm', { locale: uk });   // Додано new Date()
            const duration = formatDistance(new Date(end), new Date(start), { // Додано new Date()
              locale: uk,
              includeSeconds: false,
            });
            const entry =
              i === 0
                ? `${emoji} до ${e}`
                : i === yesterday.length - 1
                  ? `${emoji} з ${s}`
                  : `${emoji} ${s}-${e} (${duration})`;

            response = `${response}\n${entry}`;
          });
        } else {
          response += stats.lastStateBeforeYesterday
            ? ' постійно зі світлом'
            : ' взагалі без світла';
        }
      }

      // Сьогоднішня статистика
      if (
        (stats.history.today && // Додано перевірку
          stats.history.today.length > 1) ||
        stats.lastStateBeforeToday !== undefined
      ) {
        if (response.length > 0) {
          response += '\n\n';
        }
        response += `${EMOJ_KISS_HEART} Сьогодні:`;

        if (stats.history.today && stats.history.today.length > 1) { // Додано перевірку
          const today = stats.history.today;

          const baseDate = new Date();
          let baseDatePlusAvailable = new Date();
          let baseDatePluesUnavailable = new Date();

          today.forEach(({ start, end, isEnabled }, i) => {
            // Додаємо перевірку на start/end
            if (!start || !end) return;
            const s =
              i === 0
                ? convertToTimeZone(start, { timeZone: place.timezone })
                : start;
            const e =
              i === today.length - 1
                ? convertToTimeZone(end, { timeZone: place.timezone })
                : end;
            // Виправлено: різниця має бути між end та start, і обережно з типами
            let durationInMinutes = 0;
            try {
              durationInMinutes = Math.abs(differenceInMinutes(new Date(e), new Date(s)));
            } catch (diffError) {
              this.logger.error(`Error calculating differenceInMinutes for today stats: ${diffError}`);
              return; // Пропускаємо цей запис
            }

            if (isEnabled) {
              baseDatePlusAvailable = addMinutes(
                baseDatePlusAvailable,
                durationInMinutes
              );
            } else {
              baseDatePluesUnavailable = addMinutes(
                baseDatePluesUnavailable,
                durationInMinutes
              );
            }
          });

          const howLongAvailable = formatDistance(
            baseDate, // Змінено порядок аргументів
            baseDatePlusAvailable,
            { locale: uk, includeSeconds: false }
          );
          const howLongUnavailable = formatDistance(
            baseDate, // Змінено порядок аргументів
            baseDatePluesUnavailable,
            { locale: uk, includeSeconds: false }
          );

          response = `${response}\nЗі світлом: ${howLongAvailable}\nБез світла: ${howLongUnavailable}`;

          today.forEach(({ start, end, isEnabled }, i) => {
            // Додаємо перевірку на start/end
            if (!start || !end) return;
            const emoji = isEnabled ? EMOJ_BULB : EMOJ_MOON;
            const s = format(new Date(start), 'HH:mm', { locale: uk }); // Додано new Date()
            const e = format(new Date(end), 'HH:mm', { locale: uk });   // Додано new Date()
            const duration = formatDistance(new Date(end), new Date(start), { // Додано new Date()
              locale: uk,
              includeSeconds: false,
            });
            const entry =
              i === 0
                ? `${emoji} до ${e}`
                : i === today.length - 1
                  ? `${emoji} з ${s}`
                  : `${emoji} ${s}-${e} (${duration})`;

            response = `${response}\n${entry}`;
          });
        } else {
          response += stats.lastStateBeforeToday
            ? ' постійно зі світлом'
            : ' взагалі без світла';
        }
      }

      if (response === '') {
        response = 'Наразі інформація відсутня.';
      }

      response += `\n\n${MSG_DISABLED_REGULAR_SUFFIX}`;

      await telegramBot.sendMessage(msg.chat.id, response, {
        parse_mode: 'HTML',
      });
      this.logger.log(`Sent /stats response to chat ${msg.chat.id}`); // Лог відправки
    } catch (error) {
      this.logger.error(`Error in handleStatsCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
    }
  }
  private async composePlaceMonthStatsMessage(params: {
    readonly place: Place;
    readonly dateFromTargetMonth: Date;
  }): Promise<string> {
    this.logger.log(`Composing monthly stats message for place ${params.place.id}`); // Лог
    try { // Додано try...catch
      const monthStats =
        await this.electricityAvailabilityService.getMonthStats(params);
      if (!monthStats) {
        this.logger.warn(`No monthly stats data found for place ${params.place.id}`); // Лог
        return '';
      }
      this.logger.log(`Monthly stats data for place ${params.place.id}: ${JSON.stringify(monthStats)}`); // Лог даних

      const totalMinutes =
        monthStats.totalMinutesAvailable + monthStats.totalMinutesUnavailable;
      // Додаємо перевірку на нуль, щоб уникнути ділення на нуль
      if (totalMinutes === 0) {
        this.logger.warn(`Total minutes for month stats is zero for place ${params.place.id}`);
        return '';
      }
      const percentAvailable = Math.round( // Використовуємо Math.round для кращого заокруглення
        (100 * monthStats.totalMinutesAvailable) / totalMinutes
      );
      const percentUnavailable = 100 - percentAvailable;
      const baseDate = convertToTimeZone(new Date(), {
        timeZone: params.place.timezone,
      });
      const baseDatePlusAvailable = addMinutes(
        baseDate,
        monthStats.totalMinutesAvailable
      );
      const howLongAvailable = formatDistance(baseDate, baseDatePlusAvailable, {
        locale: uk,
        includeSeconds: false,
      });
      const baseDatePlusUnavailable = addMinutes(
        baseDate,
        monthStats.totalMinutesUnavailable
      );
      const howLongUnavailable = formatDistance(
        baseDate,
        baseDatePlusUnavailable,
        {
          locale: uk,
          includeSeconds: false,
        }
      );

      const m = getMonth(params.dateFromTargetMonth);
      const mn =
        m === 0 ? 'січні' : m === 1 ? 'лютому' : m === 2 ? 'березні' :
          m === 3 ? 'квітні' : m === 4 ? 'травні' : m === 5 ? 'червні' :
            m === 6 ? 'липні' : m === 7 ? 'серпні' : m === 8 ? 'вересні' :
              m === 9 ? 'жовтні' : m === 10 ? 'листопаді' : 'грудні';

      const result = `У ${mn} ми насолоджувалися світлом ${percentAvailable}% часу (сумарно ${howLongAvailable}) і потерпали від темряви ${percentUnavailable}% часу (сумарно ${howLongUnavailable}).`;
      this.logger.log(`Composed monthly stats message for place ${params.place.id}: "${result.substring(0, 50)}..."`); // Лог результату
      return result;
    } catch (error) {
      this.logger.error(`Error composing monthly stats for place ${params.place.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
      return ''; // Повертаємо порожній рядок у разі помилки
    }
  }

  private async handleAboutCommand(params: {
    readonly msg: TelegramBot.Message;
    readonly place: Place;
    readonly bot: Bot;
    readonly telegramBot: TelegramBot;
  }): Promise<void> {
    const { msg, place, telegramBot } = params;
    // Додаємо перевірку на null/undefined
    if (!msg || !place || !telegramBot) {
      this.logger.error('Missing parameters in handleAboutCommand');
      return;
    }
    this.logger.log(`Handling /about command for chat ${msg.chat.id} in place ${place.id}`); // Лог
    if (this.isGroup({ chatId: msg.chat.id })) {
      this.logger.warn(`Skipping group message: ${JSON.stringify(msg)}`);
      return;
    }
    if (place.isDisabled) {
      await this.notifyBotDisabled({ chatId: msg.chat.id, telegramBot });
      return;
    }
    try {
      this.logger.log(`Handling /about message content: ${JSON.stringify(msg)}`); // Додатковий лог
      const listedBotsMessage = "";
      await telegramBot.sendMessage(
        msg.chat.id,
        RESP_ABOUT({ listedBotsMessage }),
        {
          parse_mode: 'HTML',
        }
      );
      this.logger.log(`Sent /about response to chat ${msg.chat.id}`); // Лог відправки
    } catch (error) {
      this.logger.error(`Error in handleAboutCommand for chat ${msg.chat.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
    }
  }

  public async notifyAllPlaceSubscribersAboutElectricityAvailabilityChange(params: {
    readonly place: Place; // <--- Приймаємо Place
    readonly msg: string;   // <--- Приймаємо готове повідомлення
  }): Promise<void> {
    const { place, msg } = params;

    if (!place || !msg) {
      this.logger.error('notifyAllPlaceSubscribersAboutElectricityAvailabilityChange called with missing params');
      return;
    }

    this.logger.log(`Received request to notify subscribers for place ${place.id}`);

    // Просто викликаємо інший метод, який працює з кешем
    await this.notifyAllPlaceSubscribers({ place, msg });
  }

  // public async notifyAllPlaceSubscribersAboutElectricityAvailabilityChange(params: {
  //   readonly placeId: string;
  // }): Promise<void> {
  //   const { placeId } = params;
  //   // --- ДОДАНО ЛОГУВАННЯ ---
  //   this.logger.log(`Starting notifyAllPlaceSubscribersAboutElectricityAvailabilityChange for place ${placeId}`);
  //   // -----------------------
  //   const place = this.places[placeId];
  //   if (!place) {
  //     this.logger.error(
  //       `Place ${placeId} not found in memory cache - skipping subscriber notification`
  //     );
  //     return;
  //   }
  //   if (place.isDisabled) {
  //     this.logger.log(`Place ${placeId} is disabled, skipping notification.`); // Лог
  //     return;
  //   }
  //   try { // Додано try...catch
  //     const [latest, previous] =
  //       await this.electricityAvailabilityService.getLatestPlaceAvailability({
  //         placeId,
  //         limit: 2,
  //       });
  //     if (!latest) {
  //       this.logger.error(
  //         `Electricity availability changed event, however no availability data in the repo for place ${placeId}`
  //       );
  //       return;
  //     }
  //     // --- ДОДАНО ЛОГУВАННЯ ---
  //     this.logger.log(`Latest/Previous availability for notification (place ${placeId}): ${JSON.stringify({latest, previous})}`);
  //     // -----------------------

  //     let scheduleEnableMoment: Date | undefined;
  //     let schedulePossibleEnableMoment: Date | undefined;
  //     let scheduleDisableMoment: Date | undefined;
  //     let schedulePossibleDisableMoment: Date | undefined;

  //     // --- Жорстко вказуємо наші ключі ---
  //     const PLACE_ID_TO_SCHEDULE = "001"; // ID вашого місця
  //     const REGION_KEY = "kyiv";
  //     const QUEUE_KEY = "2.1"; // Ваша група

  //     // Оголошуємо змінну перед блоком
  //     let todaysScheduleString: string | undefined;

  //     // Перевіряємо, чи поточне місце - це те, для якого ми знаємо графік
  //     if (place.id === PLACE_ID_TO_SCHEDULE) {
  //       this.logger.debug(`[Schedule] Getting prediction for hardcoded keys: ${REGION_KEY} / ${QUEUE_KEY}`);
  //       try {
  //           // 1. Отримуємо прогноз (як і раніше)
  //           const prediction = this.scheduleCacheService.getSchedulePrediction(
  //             REGION_KEY,
  //             QUEUE_KEY
  //           );

  //           scheduleEnableMoment = prediction.scheduleEnableMoment;
  //           schedulePossibleEnableMoment = prediction.schedulePossibleEnableMoment;
  //           scheduleDisableMoment = prediction.scheduleDisableMoment;
  //           schedulePossibleDisableMoment = prediction.schedulePossibleDisableMoment;

  //           // --- 2. ДОДАЄМО ОТРИМАННЯ ПОВНОГО ГРАФІКА ---
  //           todaysScheduleString = this.scheduleCacheService.getTodaysScheduleAsText(
  //             REGION_KEY,
  //             QUEUE_KEY
  //           );
  //           // --- ------------------------------------ ---

  //       } catch (scheduleError) {
  //            this.logger.error(`[Schedule] Failed to get prediction: ${scheduleError}`);
  //       }
  //     } else {
  //        this.logger.debug(`[Schedule] Place ${place.id} is not ${PLACE_ID_TO_SCHEDULE}. Skipping prediction.`);
  //     }

  //     const latestTime = convertToTimeZone(latest.time, {
  //       timeZone: place.timezone,
  //     });
  //     const when = format(latestTime, 'HH:mm dd.MM', { locale: uk });
  //     let response: string;
  //     if (!previous) {
  //       this.logger.log(`No previous state found for place ${placeId}, sending short notification.`); // Лог
  //       const response = latest.is_available
  //       ? RESP_CURRENTLY_AVAILABLE({
  //           // ...
  //           scheduleDisableMoment,
  //           schedulePossibleDisableMoment,
  //           todaysSchedule: todaysScheduleString // <--- ПЕРЕДАЄМО РЯДОК СЮДИ
  //         })
  //       : RESP_CURRENTLY_UNAVAILABLE({
  //           // ...
  //           scheduleEnableMoment,
  //           schedulePossibleEnableMoment,
  //           todaysSchedule: todaysScheduleString // <--- І СЮДИ
  //         });
  //     } else {
  //       const previousTime = convertToTimeZone(previous.time, {
  //         timeZone: place.timezone,
  //       });
  //       const howLong = formatDistance(latestTime, previousTime, {
  //         locale: uk,
  //         includeSeconds: false,
  //       });
  //       const diffInMinutes = Math.abs(
  //         differenceInMinutes(previousTime, latestTime)
  //       );
  //       this.logger.log(`Calculating notification for place ${placeId}. Time diff: ${diffInMinutes} minutes.`); // Лог

  //       if (latest.is_available) {
  //         response =
  //           diffInMinutes <= MIN_SUSPICIOUS_DISABLE_TIME_IN_MINUTES
  //             ? RESP_ENABLED_SUSPICIOUS({ when, place: place.name })
  //             : RESP_ENABLED_DETAILED({
  //                 when,
  //                 howLong,
  //                 place: place.name,
  //                 scheduleDisableMoment, // undefined
  //                 schedulePossibleDisableMoment, // undefined
  //               });
  //       } else {
  //         response =
  //           diffInMinutes <= MIN_SUSPICIOUS_DISABLE_TIME_IN_MINUTES
  //             ? RESP_DISABLED_SUSPICIOUS({ when, place: place.name })
  //             : RESP_DISABLED_DETAILED({
  //                 when,
  //                 howLong,
  //                 place: place.name,
  //                 scheduleEnableMoment, // undefined
  //                 schedulePossibleEnableMoment, // undefined
  //               });
  //       }
  //     }
  //     // --- ДОДАНО ЛОГУВАННЯ ---
  //     this.logger.log(`Prepared notification message for place ${placeId}: "${response.substring(0, 50)}..."`);
  //     // -----------------------
  //     // Переконуємось, що place існує перед викликом
  //     if (place) {
  //         this.notifyAllPlaceSubscribers({ place, msg: response });
  //     } else {
  //         this.logger.error(`Place object was null/undefined before calling notifyAllPlaceSubscribers for placeId ${placeId}`);
  //     }
  //   } catch (error) {
  //     this.logger.error(`Error in notifyAllPlaceSubscribersAboutElectricityAvailabilityChange for place ${placeId}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
  //   }
  // }

  private async notifyAllPlaceSubscribersAboutPreviousMonthStats(params: {
    readonly place: Place;
  }): Promise<void> {
    const { place } = params;
    // Додаємо перевірку на null/undefined
    if (!place) {
      this.logger.error('Missing place parameter in notifyAllPlaceSubscribersAboutPreviousMonthStats');
      return;
    }
    this.logger.log(`Starting notifyAllPlaceSubscribersAboutPreviousMonthStats for place ${place.id}`); // Лог
    if (place.isDisabled) {
      this.logger.log(`Place ${place.id} is disabled, skipping monthly stats.`); // Лог
      return;
    }
    try { // Додано try...catch
      const dateFromPreviousMonth = addMonths(new Date(), -1);
      const statsMessage = await this.composePlaceMonthStatsMessage({ place, dateFromTargetMonth: dateFromPreviousMonth });
      if (!statsMessage) {
        this.logger.log(
          `No monthly stats message generated for ${place.name} - skipping subscriber notification`
        );
        return;
      }
      const response = RESP_PREVIOUS_MONTH_SUMMARY({ statsMessage });
      // --- ДОДАНО ЛОГУВАННЯ ---
      this.logger.log(`Prepared monthly stats notification for place ${place.id}: "${response.substring(0, 50)}..."`);
      // -----------------------
      await this.sendBulkNotificationsToPlace(place.id, response);
    } catch (error) {
      this.logger.error(`Error in notifyAllPlaceSubscribersAboutPreviousMonthStats for place ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
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

    // --- ВИДАЛЕНО ЗАПИТ ДО БД ---
    this.logger.log(`Starting notifyAllPlaceSubscribers for place ${place.id} using cache...`);
    // --- ЗАМІНЕНО НА ЦЕЙ ВИКЛИК ---
    await this.sendBulkNotificationsToPlace(place.id, msg);
    // --- --------------------- ---
  }

  private isGroup(params: { readonly chatId: number }): boolean {
    const result = params.chatId < 0;
    // this.logger.debug(`isGroup check for chatId ${params.chatId}: ${result}`); // Розкоментуйте для детального логування
    return result;
  }

  /**
     * ОНОВЛЕНИЙ: Цей метод тепер просто читає хардкод
     * І НАПОВНЮЄ КЕШ ПІДПИСНИКІВ
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

      // (Логіка створення/оновлення ботів)
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
          if (existingEntry.bot.token !== botConfig.token) {
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

      // --- !!! ВАЖЛИВО: ОНОВЛЕННЯ КЕШУ ПІДПИСНИКІВ !!! ---
      if (Object.keys(this.subscriberCache).length === 0) {
        this.logger.warn('[Cache] Subscriber cache is empty (likely due to restart). Initializing empty cache.');

        // --- КРОК 2: ДОДАЄМО ВАШ ID В КЕШ ---
        const YOUR_TELEGRAM_CHAT_ID = 229951457;
        // --- ----------------------------- ---

        for (const placeId of activePlaceIds) {
          if (placeId === HARDCODED_PLACE.id) {
            this.subscriberCache[placeId] = [YOUR_TELEGRAM_CHAT_ID]; // Додаємо вас
            this.logger.log(`[Cache] Hardcoded admin ${YOUR_TELEGRAM_CHAT_ID} to cache for place ${placeId}.`);
          } else {
            this.subscriberCache[placeId] = [];
          }
        }
      } else {
        this.logger.log('[Cache] Subscriber cache already exists in memory. Retaining.');
      }
      // --- -------------------------------------------- ---

      this.logger.log(`Finished processing bots configurations. Active instances: ${Object.keys(this.placeBots).length}`);
    } catch (e) {
      this.logger.error(`>>> ERROR inside refreshAllPlacesAndBots: ${e}`, e instanceof Error ? e.stack : undefined);
    } finally {
      this.isRefreshingPlacesAndBots = false;
      this.logger.log('>>> EXITING refreshAllPlacesAndBots()');
    }
  }

  // Змінено: createBot тепер повертає створений екземпляр або undefined
  private createBot(params: {
    readonly place: Place;
    readonly bot: Bot;
  }): TelegramBot | undefined {
    const { place, bot } = params;
    try {
      this.logger.log(`Attempting to create bot instance for place ${place.id} (${place.name}) with token starting: ${bot.token ? bot.token.substring(0, 10) : 'NO_TOKEN'}...`); // Лог
      if (!bot.token) {
        this.logger.error(`Token is missing for bot config of place ${place.id}. Cannot create instance.`);
        return undefined;
      }
      // Створюємо без polling
      const telegramBot = new TelegramBot(bot.token);
      this.logger.log(`TelegramBot instance created for place ${place.id}. Attaching listeners...`); // Лог

      // Обробники подій
      telegramBot.on('polling_error', (error) => { // Все ще корисно для діагностики внутрішніх помилок
        this.logger.error(`${place.name}/${bot.botName} internal polling_error: ${error}`);
      });
      telegramBot.on('webhook_error', (error: any) => { // Додаємо обробник помилок вебхука
        // Безпечно перевіряємо наявність 'code' та 'message'
        const errorCode = error?.code ? `Code: ${error.code}` : '';
        const errorMessage = error?.message ? error.message : JSON.stringify(error);
        this.logger.error(`${place.name}/${bot.botName} webhook_error: ${errorCode} ${errorMessage}`);
      });
      telegramBot.on('error', (error) => { // Загальний обробник помилок
        this.logger.error(`${place.name}/${bot.botName} general error: ${error}`, error instanceof Error ? error.stack : undefined); // Додано stack
      });

      // Обробники команд
      // Додаємо try...catch навколо кожного виклику handle... для кращої діагностики
      telegramBot.onText(/\/start/, (msg) => {
        this.logger.debug(`Received /start for place ${place.id} via onText`); // Лог
        this.handleStartCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleStartCommand: ${err}`, err instanceof Error ? err.stack : undefined)); // Додано instanceof
      });
      telegramBot.onText(/\/current/, (msg) => {
        this.logger.debug(`Received /current for place ${place.id} via onText`); // Лог
        this.handleCurrentCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleCurrentCommand: ${err}`, err instanceof Error ? err.stack : undefined)); // Додано instanceof
      });
      telegramBot.onText(/\/subscribe/, (msg) => {
        this.logger.debug(`Received /subscribe for place ${place.id} via onText`); // Лог
        this.handleSubscribeCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleSubscribeCommand: ${err}`, err instanceof Error ? err.stack : undefined)); // Додано instanceof
      });
      telegramBot.onText(/\/unsubscribe/, (msg) => {
        this.logger.debug(`Received /unsubscribe for place ${place.id} via onText`); // Лог
        this.handleUnsubscribeCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleUnsubscribeCommand: ${err}`, err instanceof Error ? err.stack : undefined)); // Додано instanceof
      });
      telegramBot.onText(/\/stop/, (msg) => {
        this.logger.debug(`Received /stop for place ${place.id} via onText`); // Лог
        this.handleUnsubscribeCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleUnsubscribeCommand (stop): ${err}`, err instanceof Error ? err.stack : undefined)); // Додано instanceof
      });
      telegramBot.onText(/\/stats/, (msg) => {
        this.logger.debug(`Received /stats for place ${place.id} via onText`); // Лог
        this.handleStatsCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleStatsCommand: ${err}`, err instanceof Error ? err.stack : undefined)); // Додано instanceof
      });
      telegramBot.onText(/\/about/, (msg) => {
        this.logger.debug(`Received /about for place ${place.id} via onText`); // Лог
        this.handleAboutCommand({ msg, place, bot, telegramBot }).catch(err => this.logger.error(`Unhandled error in handleAboutCommand: ${err}`, err instanceof Error ? err.stack : undefined)); // Додано instanceof
      });

      // --- ДОДАНО НОВИЙ ОБРОБНИК ДЛЯ /update ---
      telegramBot.onText(/\/update/, async (msg) => {
        const userId = msg.from?.id;
        const chatId = msg.chat.id;
        this.logger.log(`Received /update command from user ${userId} in chat ${chatId} for place ${place.id}`);

        // // Опціонально: Перевірка прав адміністратора
        const ADMIN_USER_ID = "229951457";
        if (String(userId) !== ADMIN_USER_ID) { // <--- ПРИБЕРІТЬ ПЕРЕВІРКУ !ADMIN_USER_ID
          this.logger.warn(`User ${userId} is not authorized to run /update for place ${place.id}.`);
          try {
            await telegramBot.sendMessage(chatId, '❌ У вас недостатньо прав для виконання цієї команди.');
          } catch (replyError) { this.logger.error(`Error sending unauthorized message for /update: ${replyError}`); }
          return;
        }
        // Виконуємо оновлення
        try {
          // --- ЗМІНЕНО ТЕКСТ ---
          await telegramBot.sendMessage(chatId, '🔄 Запускаю оновлення конфігурацій та внутрішнього кешу...');
          // --- ---------------- ---

          // Спочатку оновлюємо конфігурації ботів (як і раніше)
          await this.refreshAllPlacesAndBots();

          // --- ДОДАНО ВИКЛИК ОНОВЛЕННЯ КЕШУ СТАНІВ ---
          await this.electricityAvailabilityService.refreshInternalCache();
          // --- --------------------------------------- ---

          // --- ЗМІНЕНО ТЕКСТ ---
          await telegramBot.sendMessage(chatId, '✅ Оновлення завершено!');
          // --- ---------------- ---
          this.logger.log(`/update command processed successfully for place ${place.id}`);
        } catch (error) {
          this.logger.error(`Error during /update command processing for place ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
          try {
            // --- ЗМІНЕНО ТЕКСТ ---
            await telegramBot.sendMessage(chatId, '❌ Помилка під час оновлення. Перевірте логи.');
            // --- ---------------- ---
          } catch (replyError) { this.logger.error(`Error sending error message for /update: ${replyError}`); }
        }
      });
      // --- КІНЕЦЬ НОВОГО ОБРОБНИКА /update ---

      // --- ДОДАЄМО НОВИЙ ОБРОБНИК ДЛЯ /schedule ---
      telegramBot.onText(/\/schedule/, async (msg) => {
        const userId = msg.from?.id;
        const chatId = msg.chat.id;
        this.logger.log(`Received /schedule command from user ${userId} in chat ${chatId} for place ${place.id}`);

        // (Тут ваша перевірка на адміна)
        // ...

        try {
          await telegramBot.sendMessage(chatId, '🔄 Запускаю завантаження графіків з API (svitlo-proxy)...');

          // 1. Завантажуємо графіки
          const success = await this.scheduleCacheService.fetchAndCacheSchedules();

          if (success) {
            this.logger.log(`[ScheduleCommand] Fetch successful. Generating schedule text for chat ${chatId}.`);

            // Використовуємо ті самі хардкод-ключі, що й для /current
            const PLACE_ID_TO_SCHEDULE = "001";
            const REGION_KEY = "kyiv";
            const QUEUE_KEY = "2.1"; // <--- Або ваша група

            let scheduleTodayString = "<i>Графік на сьогодні не знайдено.</i>";
            let scheduleTomorrowString = "<i>Графік на завтра не знайдено.</i>"; // <-- Нова змінна

            if (place.id === PLACE_ID_TO_SCHEDULE) {
              try {
                // Отримуємо графік на сьогодні
                scheduleTodayString = this.scheduleCacheService.getTodaysScheduleAsText(
                  REGION_KEY,
                  QUEUE_KEY
                );
                // Отримуємо графік на завтра
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

            // 3. Створюємо фінальне повідомлення з обома графіками
            const responseMessage = `✅ Графіки успішно оновлено.\n\n` +
              `<b>--- Графік на сьогодні ---</b>\n` +
              `${scheduleTodayString}\n\n` +
              `<b>--- Графік на завтра ---</b>\n` +
              `${scheduleTomorrowString}`;

            await telegramBot.sendMessage(chatId, responseMessage, { parse_mode: 'HTML' });

            this.logger.log(`/schedule command processed successfully for place ${place.id}`);
          } else {
            // (Помилка завантаження)
            await telegramBot.sendMessage(chatId, '❌ Не вдалося завантажити графіки. API (svitlo-proxy) не відповідає.');
            this.logger.warn(`/schedule command FAILED for place ${place.id} (API error).`);
          }
        } catch (error) {
          this.logger.error(`Error during /schedule command processing for place ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
          await telegramBot.sendMessage(chatId, '❌ Сталася внутрішня помилка. Перевірте логи.');
        }
      });
      // --- КІНЕЦЬ НОВОГО ОБРОБНИКА /schedule ---      

      this.logger.log(`Successfully created bot instance and attached listeners for place ${place.id}.`); // Лог
      return telegramBot; // Повертаємо створений екземпляр
    } catch (error) {
      this.logger.error(`>>> FAILED during new TelegramBot() or attaching listeners for place ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined); // Лог помилки
      return undefined; // Повертаємо undefined у разі помилки
    }
  }

  public getMainTelegramBotInstance(): TelegramBot | undefined {
    this.logger.log(`getMainTelegramBotInstance called. Current this.placeBots keys: ${JSON.stringify(Object.keys(this.placeBots))}`);

    // Оскільки у нас лише один бот, ми можемо взяти його ID з хардкоду
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
    // Додаємо перевірку на null/undefined
    if (!chatId || !telegramBot) {
      this.logger.error('Missing parameters in notifyBotDisabled');
      return;
    }
    try { // Додано try...catch
      this.logger.log(`Sending MSG_DISABLED to chat ${chatId}`); // Лог
      await telegramBot.sendMessage(chatId, MSG_DISABLED, { parse_mode: 'HTML' });
    } catch (error) {
      this.logger.error(`Error sending MSG_DISABLED to chat ${chatId}: ${error}`); // Лог помилки
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
