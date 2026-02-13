import { HttpService } from '@nestjs/axios';
import { Cron } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
//import { dt as dt_util } from 'homeassistant-util-dt'; // (Потрібно імітувати)
import { isBefore, isEqual, addMinutes, differenceInMinutes, format, startOfHour } from 'date-fns';
import { convertToTimeZone } from 'date-fns-timezone';
import { uk } from 'date-fns/locale';
import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { NotificationBotService } from '@electrobot/bot';
import { GpvConfigService } from './gpv-config.service';
import { OutageDataService } from './outage-data.service';
import { TomorrowScheduleTrackerService } from './tomorrow-schedule-tracker.service';
import {
  EMOJ_BULB,
  EMOJ_MOON,
  EMOJ_CHECK_MARK,
  EMOJ_GRAY_Q,
  EMOJ_GREEN_CIRCLE,
  EMOJ_HOURGLASS,
} from '@electrobot/bot';

// --- Імітація dt_util з Home Assistant ---
// (Ми не можемо імпортувати 'homeassistant-util-dt', тому створимо свою версію)
const TZ_KYIV = 'Europe/Kiev';
const dt_util_mock = {
  now: (timeZone: string) => convertToTimeZone(new Date(), { timeZone }),
  as_utc: (date: Date) => date.toISOString(), // Просто конвертуємо в ISO UTC
};
// --- Кінець імітації ---

// --- startOfHalfHour ---
function startOfHalfHour(date: Date): Date {
  const newDate = new Date(date);
  const minutes = newDate.getMinutes();
  if (minutes < 30) {
    newDate.setMinutes(0, 0, 0); // Встановлюємо на :00
  } else {
    newDate.setMinutes(30, 0, 0); // Встановлюємо на :30
  }
  return newDate;
}
// --- End startOfHalfHour ---

// API URL, який ми знайшли
const API_URL = "https://svitlo-proxy.svitlo-proxy.workers.dev";

// Стан світла (1 = є, 2 = немає, 0 = можливо)
export enum LightStatus {
  ON = 1,
  OFF = 2,
  POSSIBLE = 0,
  UNKNOWN = -1
}

// Інтерфейс для нашого кешу (спрощений)
interface ScheduleCache {
  date_today: string;       // "2025-11-13"
  date_tomorrow: string;  // "2025-11-14"
  regions: Array<{
    cpu: string;            // "kyiv"
    schedule: {
      [queueKey: string]: { // "2.1"
        [date: string]: {   // "2025-11-13"
          [time: string]: number; // "00:00": 1
        }
      }
    }
  }>;
}

// Інтерфейс для результату
export interface SchedulePrediction {
  scheduleEnableMoment?: Date;
  schedulePossibleEnableMoment?: Date;
  scheduleDisableMoment?: Date;
  schedulePossibleDisableMoment?: Date;
}


@Injectable()
export class ScheduleCacheService implements OnModuleInit {
  private readonly logger = new Logger(ScheduleCacheService.name);
  private scheduleCache: ScheduleCache | null = null;
  private isFetching = false;
  private lastNotifiedScheduleJSON: string | null = null;

  // Outage-data: Кеш для останнього графіка з outage-data-ua
  private lastOutageSchedule: any = null;

  constructor(
    private readonly httpService: HttpService,
    @Inject(forwardRef(() => NotificationBotService))
    private readonly notificationBotService: NotificationBotService,
    private readonly gpvConfigService: GpvConfigService,
    private readonly outageDataService: OutageDataService,
    private readonly tomorrowScheduleTracker: TomorrowScheduleTrackerService
  ) { }

  /**
   * Завантажує кеш при старті програми
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('Starting initial schedule cache fetch...');
    await this.fetchAndCacheSchedules();
  }

  @Cron('*/15 * * * *') // Раз на 15 хвилин (синхронізовано з OutageData)
  public async fetchAndCacheSchedules(notifyUsers: boolean = true): Promise<boolean> {
    if (this.isFetching) {
      this.logger.warn('[ScheduleCache] Fetch already in progress. Skipping.');
      return false;
    }
    this.isFetching = true;
    this.logger.log(`[ScheduleCache] Checking for schedule updates (OutageData)...`);

    try {
      // 1. Отримуємо налаштовану групу
      const gpvGroup = this.gpvConfigService.getGpvGroup();
      if (!gpvGroup) {
        this.logger.debug('[ScheduleCache] No GPV group configured. Skipping update check.');
        return false;
      }

      // 2. Оновлюємо дані з GitHub
      const rawData = await this.outageDataService.fetchKyivSchedule();
      if (!rawData) {
        this.logger.warn('[ScheduleCache] Failed to fetch data from GitHub.');
        return false;
      }

      // 3. Парсимо графік для нашої групи (на сьогодні)
      const currentScheduleObj = this.outageDataService.parseGroupSchedule(gpvGroup);
      if (!currentScheduleObj) {
        this.logger.warn(`[ScheduleCache] Failed to parse schedule for GPV${gpvGroup}.`);
        return false;
      }

      const currentSchedule = currentScheduleObj.schedule;
      const dateTodayStr = new Date().toLocaleDateString('uk-UA', { day: 'numeric', month: 'numeric' });

      // 4. Перевіряємо на зміни (порівнюємо з попереднім збереженим станом)
      let scheduleChanged = false;
      let diffText = '';

      if (this.lastOutageSchedule) {
        diffText = this.generateOutageScheduleDiff(this.lastOutageSchedule, currentSchedule);
        if (diffText) {
          scheduleChanged = true;
          this.logger.log(`[ScheduleCache] Detected changes in schedule:\n${diffText}`);
        } else {
          this.logger.debug('[ScheduleCache] No changes in schedule.');
        }
      } else {
        // Перший запуск - просто зберігаємо
        this.logger.log('[ScheduleCache] Initial schedule fetch. Saving state.');
        this.lastOutageSchedule = currentSchedule;

        // 5a. Оновлюємо ЛЕГАСІ кеш
        this.updateLegacyCache(currentSchedule, false);

        // Спробуємо оновити і для завтра, якщо є
        const tomorrowTimestamp = this.outageDataService.getTomorrowTimestamp();
        if (tomorrowTimestamp) {
          const tomorrowSchedule = this.outageDataService.parseGroupScheduleForDate(gpvGroup, tomorrowTimestamp);
          if (tomorrowSchedule) this.updateLegacyCache(tomorrowSchedule.schedule, true);
        }

        // --- ADDED: Send Notification on Startup ---
        if (notifyUsers) {
          this.logger.log('[ScheduleCache] Preparing startup notification...');
          const fullScheduleText = this.outageDataService.formatScheduleWithPeriods(currentScheduleObj);
          const lastUpdatedFormatted = this.outageDataService.formatLastUpdated(
            currentScheduleObj.updateFact || currentScheduleObj.lastUpdated
          );
          const msg = `🔔 **Бот запущено! Графік на сьогодні (${dateTodayStr})**\n\n` +
            `📋 **Повний графік:**\n${fullScheduleText}\n\n` +
            `_Оновлено: ${lastUpdatedFormatted}_`;

          this.logger.log(`[ScheduleCache] Sending startup notification for group ${gpvGroup}`);
          const imageUrl = this.outageDataService.getImageUrl(gpvGroup);
          await this.notificationBotService.sendScheduleUpdateWithImage(msg, imageUrl);
          this.logger.log('[ScheduleCache] Startup notification sent successfully');
        }
        // -------------------------------------------

        return true;
      }

      // 5. Зберігаємо новий стан
      this.lastOutageSchedule = currentSchedule;

      // 5a. Оновлюємо ЛЕГАСІ кеш
      this.updateLegacyCache(currentSchedule, false);

      const tomorrowTimestamp = this.outageDataService.getTomorrowTimestamp();
      if (tomorrowTimestamp) {
        const tomorrowSchedule = this.outageDataService.parseGroupScheduleForDate(gpvGroup, tomorrowTimestamp);
        if (tomorrowSchedule) this.updateLegacyCache(tomorrowSchedule.schedule, true);
      }

      // 6. Формуємо повідомлення, якщо були зміни
      // Але не надсилаємо якщо це просто перехід дня (завтра стало сьогодні)
      const isDayRollover = this.isDayRollover(this.lastOutageSchedule, currentSchedule);

      if (notifyUsers && scheduleChanged && !isDayRollover) {
        // Форматуємо новий повний графік (згорнутий)
        const fullScheduleText = this.outageDataService.formatScheduleWithPeriods(currentScheduleObj);

        // Форматуємо час оновлення (відносно)
        const lastUpdatedFormatted = this.outageDataService.formatLastUpdated(
          currentScheduleObj.updateFact || currentScheduleObj.lastUpdated
        );

        let msg = `🔔 **Оновлено графік на сьогодні (${dateTodayStr})!**\n\n`;

        msg += `**Зміни:**\n${diffText}\n\n`;
        msg += `📋 **Новий графік:**\n${fullScheduleText}\n\n`;
        msg += `_Оновлено: ${lastUpdatedFormatted}_`;

        this.logger.log(`[ScheduleCache] Sending notification: ${msg}`);
        const imageUrl = this.outageDataService.getImageUrl(gpvGroup);
        await this.notificationBotService.sendScheduleUpdateWithImage(msg, imageUrl);
      } else if (scheduleChanged && isDayRollover) {
        this.logger.log('[ScheduleCache] Day rollover detected (tomorrow became today), skipping change notification');
      }

      // Перевіряємо чи є готове повідомлення про завтрашній графік
      const tomorrowMessage = this.tomorrowScheduleTracker.getAndClearLastNotification();
      const tomorrowImageUrl = this.tomorrowScheduleTracker.getAndClearLastNotificationImageUrl();

      if (tomorrowMessage && notifyUsers) {
        this.logger.log(`[ScheduleCache] Sending tomorrow schedule notification`);

        if (tomorrowImageUrl) {
          await this.notificationBotService.sendScheduleUpdateWithImage(tomorrowMessage, tomorrowImageUrl);
        } else {
          // Fallback to text-only if image URL is missing
          await this.notificationBotService.sendScrapedNotification(tomorrowMessage);
        }
      }

      return true;

    } catch (error: any) {
      this.logger.error(`[ScheduleCache] Error in fetchAndCacheSchedules: ${error.message}`, error.stack);
      return false;
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Оновлює легасі кеш (this.scheduleCache) даними з нового сервісу.
   * Це потрібно для коректної роботи findLastScheduledChange та ElectricityAvailabilityService.
   */
  private updateLegacyCache(schedule: Record<string, string>, isTomorrow: boolean = false): void {
    if (!this.scheduleCache) {
      this.scheduleCache = {
        date_today: new Date().toISOString().split('T')[0],
        date_tomorrow: '',
        regions: []
      };
    }

    const MY_REGION_KEY = 'kyiv';
    const MY_QUEUE_KEY = '2.1';

    if (!this.scheduleCache.regions) this.scheduleCache.regions = [];
    let region = this.scheduleCache.regions.find(r => r.cpu === MY_REGION_KEY);
    if (!region) {
      region = { cpu: MY_REGION_KEY, schedule: { [MY_QUEUE_KEY]: {} } };
      this.scheduleCache.regions.push(region);
    }

    // Визначаємо дату (ключ)
    // Визначаємо дату (ключ) з урахуванням TZ_KYIV
    let dateKey: string;
    if (isTomorrow) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowKyiv = convertToTimeZone(tomorrow, { timeZone: TZ_KYIV });
      dateKey = format(tomorrowKyiv, 'yyyy-MM-dd');

      this.scheduleCache.date_tomorrow = dateKey;
    } else {
      const nowKyiv = convertToTimeZone(new Date(), { timeZone: TZ_KYIV });
      dateKey = format(nowKyiv, 'yyyy-MM-dd');

      this.scheduleCache.date_today = dateKey;
    }

    this.logger.log(`[ScheduleCache] Updating legacy cache for ${isTomorrow ? 'tomorrow' : 'today'} (Keys: ${Object.keys(schedule).length})`);

    // Формуємо слоти 00:00, 00:30 ...
    const slots: { [time: string]: number } = {};
    const keys = Object.keys(schedule).map(Number).sort((a, b) => a - b);

    // Detect 1-based indexing (e.g., 1..24)
    // If min is 1 and max is 24, we assume it's 1-based and needs -1 offset.
    const minKey = keys.length > 0 ? keys[0] : 0;
    const maxKey = keys.length > 0 ? keys[keys.length - 1] : 0;
    const offset = (minKey === 1 && maxKey === 24) ? -1 : 0;

    for (const key of keys) {
      // Try unpadded first, then padded
      let status = schedule[key];
      if (status === undefined) {
        status = schedule[String(key).padStart(2, '0')];
      }

      const hourIndex = key + offset;
      if (hourIndex < 0 || hourIndex > 23) continue;

      const hourStr = String(hourIndex).padStart(2, '0');

      // 00:00
      slots[`${hourStr}:00`] = this.mapOutageStatusToLightStatus(String(status), 1);
      // 00:30
      slots[`${hourStr}:30`] = this.mapOutageStatusToLightStatus(String(status), 2);
    }

    // Зберігаємо в кеш
    if (!region.schedule) region.schedule = {};

    // Ініціалізуємо об'єкт для черги, якщо його немає
    if (!region.schedule[MY_QUEUE_KEY]) {
      region.schedule[MY_QUEUE_KEY] = {};
    }

    region.schedule[MY_QUEUE_KEY][dateKey] = slots;

    this.logger.debug(`[ScheduleCache] Updated legacy cache for ${dateKey} (isTomorrow=${isTomorrow})`);
  }

  private mapOutageStatusToLightStatus(status: string, halfHour: 1 | 2): number {
    if (status === 'yes') return LightStatus.ON; // 1
    if (status === 'no') return LightStatus.OFF; // 2
    if (status === 'first') return halfHour === 1 ? LightStatus.OFF : LightStatus.ON;
    if (status === 'second') return halfHour === 1 ? LightStatus.ON : LightStatus.OFF;
    return LightStatus.UNKNOWN; // -1
  }

  /**
   * Генерує текстовий опис змін між двома графіками (OutageData)
   */
  private generateOutageScheduleDiff(oldSchedule: { [hour: string]: string }, newSchedule: { [hour: string]: string }): string {
    const changes: string[] = [];
    const hours = Object.keys(newSchedule).sort((a, b) => parseInt(a) - parseInt(b));

    interface ChangeBlock {
      start: number;
      end: number;
      oldStatus: string;
      newStatus: string;
    }

    let currentBlock: ChangeBlock | null = null;

    for (const hourStr of hours) {
      const hour = parseInt(hourStr);
      const oldStatus = oldSchedule[hourStr];
      const newStatus = newSchedule[hourStr];

      if (oldStatus !== newStatus) {
        // Початок нової зміни або продовження існуючої
        if (currentBlock) {
          if (currentBlock.oldStatus === oldStatus && currentBlock.newStatus === newStatus && currentBlock.end === hour) {
            // Продовжуємо блок
            currentBlock.end = hour + 1;
          } else {
            // Закриваємо попередній блок і починаємо новий
            changes.push(this.formatOutageDiffBlock(currentBlock));
            currentBlock = { start: hour, end: hour + 1, oldStatus, newStatus };
          }
        } else {
          // Починаємо новий блок
          currentBlock = { start: hour, end: hour + 1, oldStatus, newStatus };
        }
      } else {
        // Статус не змінився, закриваємо блок якщо був
        if (currentBlock) {
          changes.push(this.formatOutageDiffBlock(currentBlock));
          currentBlock = null;
        }
      }
    }

    if (currentBlock) {
      changes.push(this.formatOutageDiffBlock(currentBlock));
    }

    return changes.join('\n');
  }

  private formatOutageDiffBlock(block: { start: number, end: number, oldStatus: string, newStatus: string }): string {
    const startStr = `${String(block.start).padStart(2, '0')}:00`;
    const endStr = `${String(block.end).padStart(2, '0')}:00`;

    const getEmoji = (status: string) => {
      if (status === 'yes') return '💡';
      if (status === 'no') return '🌚';
      if (status === 'first') return '🕐';
      if (status === 'second') return '🕑';
      return '❓';
    };

    return `${startStr} - ${endStr}: ${getEmoji(block.oldStatus)} ➡️ ${getEmoji(block.newStatus)}`;
  }

  /**
   * Головний метод. Отримує прогноз на основі кешованих даних.
   */
  public getSchedulePrediction(regionKey: string, queueKey: string): SchedulePrediction {
    if (!this.scheduleCache) {
      this.logger.warn(`[Prediction] Schedule cache is empty. Cannot give prediction.`);
      return {};
    }

    try {
      // 1. Знаходимо наш регіон
      const region = this.scheduleCache.regions.find(r => r.cpu === regionKey);
      if (!region) {
        this.logger.warn(`[Prediction] Region "${regionKey}" not found in cache.`);
        return {};
      }

      // 2. Знаходимо нашу групу (чергу)
      const schedule = region.schedule[queueKey];
      if (!schedule) {
        this.logger.warn(`[Prediction] Queue "${queueKey}" not found for region "${regionKey}".`);
        return {};
      }

      // 3. Отримуємо дати
      const dateTodayStr = this.scheduleCache.date_today;
      const dateTomorrowStr = this.scheduleCache.date_tomorrow;

      // 4. Отримуємо графіки на сьогодні і завтра
      const slotsToday = schedule[dateTodayStr] || {};
      const slotsTomorrow = schedule[dateTomorrowStr] || {};

      const nowKyiv = dt_util_mock.now(TZ_KYIV);

      // Знаходимо наступне "ГАРАНТОВАНЕ" ввімкнення/вимкнення
      const nextOn = this.findNextSlot(nowKyiv, dateTodayStr, slotsToday, dateTomorrowStr, slotsTomorrow, [LightStatus.ON]);
      const nextOff = this.findNextSlot(nowKyiv, dateTodayStr, slotsToday, dateTomorrowStr, slotsTomorrow, [LightStatus.OFF]);

      // Знаходимо наступне "МОЖЛИВЕ" ввімкнення/вимкнення (сіра зона)
      const nextMaybeOn = this.findNextSlot(nowKyiv, dateTodayStr, slotsToday, dateTomorrowStr, slotsTomorrow, [LightStatus.POSSIBLE]);
      const nextMaybeOff = nextMaybeOn; // У цьому API "можливе" - це один стан (0), він може бути і вкл і викл

      return {
        scheduleEnableMoment: nextOn,
        schedulePossibleEnableMoment: nextMaybeOn, // Використовуємо "сіру зону" (0)
        scheduleDisableMoment: nextOff,
        schedulePossibleDisableMoment: nextMaybeOff, // Використовуємо "сіру зону" (0)
      };

    } catch (error) {
      this.logger.error(`[Prediction] Error during parsing schedule cache for ${regionKey}/${queueKey}: ${error}`);
      return {};
    }
  }

  /**
     * (КРОК 2)
     * Створює гарний рядок з графіком на сьогодні (ОНОВЛЕНО v2)
     */
  /**
   * Повертає графік на сьогодні у текстовому вигляді (використовує OutageDataService)
   */
  public getTodaysScheduleAsText(regionKey: string, queueKey: string): string {
    const gpvGroup = this.gpvConfigService.getGpvGroup();
    if (!gpvGroup) return 'Група не налаштована';

    const schedule = this.outageDataService.parseGroupSchedule(gpvGroup);
    if (!schedule) return 'Графік не знайдено';

    return this.outageDataService.formatScheduleWithPeriods(schedule);
  }

  /**
     * Допоміжний метод для об'єднання однакових слотів (ВИПРАВЛЕНА ЛОГІКА v11)
     */
  private compressScheduleText(lines: string[]): string {
    if (lines.length === 0) return '';

    const compressed: string[] = [];
    let startLine = lines[0]; // Приклад: "🔙 00:00: 💡"

    for (let i = 1; i < lines.length; i++) {
      const currentLine = lines[i];

      const startParts = startLine.split(' ');
      const currentParts = currentLine.split(' ');
      if (startParts.length < 3 || currentParts.length < 3) continue;

      const startStatus = startParts[2]; // 💡
      const currentStatus = currentParts[2]; // 💡
      const currentPrefix = currentParts[0]; // 🟢

      // --- !!! ГОЛОВНЕ ВИПРАВЛЕННЯ (v11) !!! ---
      // Якщо СТАТУС змінився (💡 -> 🌚), ми завершуємо групу
      if (startStatus !== currentStatus) {

        const startPrefix = startParts[0];
        const startTime = startParts[1].slice(0, -1);
        const endTime = currentParts[1].slice(0, -1); // Час початку поточного

        compressed.push(`${startPrefix} ${startTime} - ${endTime} ${startStatus}`);
        startLine = currentLine; // Починаємо нову групу

      } else {
        // Статус той самий (🌚 === 🌚).
        // Перевіряємо, чи не є ПОТОЧНИЙ рядок "поточним" (🟢).
        if (currentPrefix === EMOJ_GREEN_CIRCLE) {
          // "Просуваємо" 🟢 на початок всієї групи
          startLine = `${EMOJ_GREEN_CIRCLE} ${startParts[1]} ${startStatus}`;
        }
      }
      // --- КІНЕЦЬ ВИПРАВЛЕННЯ ---
    }

    // Додаємо останній блок
    const lastParts = startLine.split(' ');
    if (lastParts.length < 3) return compressed.join('\n');

    const lastPrefix = lastParts[0];
    const lastStatus = lastParts[2];
    const lastStartTime = lastParts[1].slice(0, -1);

    compressed.push(`${lastPrefix} ${lastStartTime} - 00:00 ${lastStatus}`);

    return compressed.join('\n');
  }

  public findLastScheduledChange(
    now: Date,
    regionKey: string,
    queueKey: string
  ): { time: Date | null, status: LightStatus } {

    if (!this.scheduleCache) {
      return { time: null, status: LightStatus.UNKNOWN };
    }

    try {
      const region = this.scheduleCache.regions.find(r => r.cpu === regionKey);
      const schedule = region?.schedule[queueKey];
      const date = this.scheduleCache.date_today;
      const slots = schedule?.[date];
      if (!slots) {
        return { time: null, status: LightStatus.UNKNOWN };
      }

      const allChanges: Array<{ time: Date; status: LightStatus }> = [];

      let prevStatus: LightStatus = slots["00:00"] ?? LightStatus.UNKNOWN;

      for (let hour = 0; hour < 24; hour++) {
        for (let minute of [0, 30]) {
          const key = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
          const curStatus = slots[key] ?? prevStatus;

          if (!(hour === 0 && minute === 0) && curStatus !== prevStatus) {
            // Кажемо, що час з API - це Київський час (UTC+2)
            const utc = new Date(`${date}T${key}:00.000+02:00`); // <--- ВИПРАВЛЕНО
            allChanges.push({ time: utc, status: curStatus });
          }

          prevStatus = curStatus;
        }
      }

      let baseUtc = new Date(`${date}T00:00:00.000Z`);
      let baseLocal = convertToTimeZone(baseUtc, { timeZone: TZ_KYIV });

      const baseStatus: LightStatus = slots["00:00"] ?? LightStatus.UNKNOWN;

      let activeStartTime = baseLocal;
      let activeStatus = baseStatus;

      for (const change of allChanges) {
        if (change.time > now) {
          break;
        }
        activeStartTime = change.time;
        activeStatus = change.status;
      }

      return { time: activeStartTime, status: activeStatus };
    } catch {
      return { time: null, status: LightStatus.UNKNOWN };
    }
  }

  public findNextScheduledChange(
    now: Date,
    regionKey: string,
    queueKey: string
  ): { time: Date | null, status: LightStatus } {

    if (!this.scheduleCache) {
      return { time: null, status: LightStatus.UNKNOWN };
    }

    try {
      const region = this.scheduleCache.regions.find(r => r.cpu === regionKey);
      const schedule = region?.schedule[queueKey];
      const date = this.scheduleCache.date_today;
      const slots = schedule?.[date];
      if (!slots) {
        return { time: null, status: LightStatus.UNKNOWN };
      }

      const allChanges: Array<{ time: Date; status: LightStatus }> = [];

      let prevStatus: LightStatus = slots["00:00"] ?? LightStatus.UNKNOWN;

      for (let hour = 0; hour < 24; hour++) {
        for (let minute of [0, 30]) {
          const key = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
          const curStatus = slots[key] ?? prevStatus;

          if (!(hour === 0 && minute === 0) && curStatus !== prevStatus) {
            // Кажемо, що час з API - це Київський час (UTC+2)
            const utc = new Date(`${date}T${key}:00.000+02:00`); // <--- ВИПРАВЛЕНО
            allChanges.push({ time: utc, status: curStatus });
          }

          prevStatus = curStatus;
        }
      }

      for (const change of allChanges) {
        if (change.time > now) {
          return change;
        }
      }

      return { time: null, status: LightStatus.UNKNOWN };
    } catch {
      return { time: null, status: LightStatus.UNKNOWN };
    }
  }


  /**
   * Повертає графік на завтра у текстовому вигляді (використовує OutageDataService)
   */
  public getTomorrowsScheduleAsText(regionKey: string, queueKey: string): string {
    const gpvGroup = this.gpvConfigService.getGpvGroup();
    if (!gpvGroup) return 'Група не налаштована';

    const tomorrowTimestamp = this.outageDataService.getTomorrowTimestamp();
    if (!tomorrowTimestamp) return 'Графік на завтра відсутній';

    const schedule = this.outageDataService.parseGroupScheduleForDate(gpvGroup, tomorrowTimestamp);
    if (!schedule) return 'Графік на завтра не знайдено';

    if (this.outageDataService.isPlaceholderSchedule(schedule.schedule)) {
      return '';
    }

    // Створюємо дату завтрашнього дня для правильних заголовків
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    return this.outageDataService.formatScheduleWithPeriods(schedule, tomorrow);
  }

  /**
   * Допоміжний метод для пошуку наступного слоту (ОНОВЛЕНО: шукає майбутню зміну стану)
   */
  private findNextSlot(
    now: Date,
    todayDateStr: string,
    todaySlots: Record<string, number>,
    tomorrowDateStr: string,
    tomorrowSlots: Record<string, number>,
    targetStates: LightStatus[]
  ): Date | undefined {

    const todayStart = convertToTimeZone(new Date(todayDateStr), { timeZone: TZ_KYIV });
    const tomorrowStart = convertToTimeZone(new Date(tomorrowDateStr), { timeZone: TZ_KYIV });

    // Знаходимо поточний 30-хвилинний слот
    const currentSlotTime = startOfHalfHour(now);

    // Перебираємо наступні 48 годин (96 слотів)
    for (let i = 0; i < 96; i++) {
      const slotTime = addMinutes(currentSlotTime, i * 30);

      // Пропускаємо слоти, які вже минули (або це поточний слот)
      // Ми шукаємо ПОДІЮ в майбутньому.
      if (slotTime <= now) {
        continue;
      }

      const slotDateStr = format(slotTime, 'yyyy-MM-dd');
      const slotTimeStr = format(slotTime, 'HH:mm');

      let status: LightStatus;

      if (slotDateStr === todayDateStr && todaySlots[slotTimeStr] !== undefined) {
        status = todaySlots[slotTimeStr];
      } else if (slotDateStr === tomorrowDateStr && tomorrowSlots[slotTimeStr] !== undefined) {
        status = tomorrowSlots[slotTimeStr];
      } else {
        continue; // Даних за цей слот немає
      }

      // Перевіряємо, чи цей слот є тим, що ми шукаємо
      if (targetStates.includes(status)) {

        // ДОДАТКОВА ПЕРЕВІРКА:
        // Ми хочемо знайти ПОЧАТОК періоду.
        // Тобто попередній слот має бути ІНШОГО стану.
        // Або це має бути перший слот, який ми перевіряємо (але ми вже пропустили минулі).

        const prevSlotTime = addMinutes(slotTime, -30);
        const prevSlotDateStr = format(prevSlotTime, 'yyyy-MM-dd');
        const prevSlotTimeStr = format(prevSlotTime, 'HH:mm');

        let prevStatus: LightStatus = LightStatus.UNKNOWN;
        if (prevSlotDateStr === todayDateStr && todaySlots[prevSlotTimeStr] !== undefined) {
          prevStatus = todaySlots[prevSlotTimeStr];
        } else if (prevSlotDateStr === tomorrowDateStr && tomorrowSlots[prevSlotTimeStr] !== undefined) {
          prevStatus = tomorrowSlots[prevSlotTimeStr];
        }

        // Якщо попередній статус ТАКИЙ САМИЙ, як поточний -> це не початок періоду, це його продовження.
        // Ми пропускаємо це, бо нам потрібен саме МОМЕНТ ПЕРЕМИКАННЯ.
        // (Хіба що ми хочемо знайти "найближчий слот з таким станом", але для сповіщення "очікуємо вимкнення о..."
        // логічніше давати час ПОЧАТКУ вимкнення).

        if (prevStatus !== status) {
          return slotTime;
        }
      }
    }

    return undefined; // Не знайдено
  }

  /**
   * Генерує текстовий опис змін між двома графіками
   */
  private generateScheduleDiff(oldJson: string, newJson: string): string {
    try {
      const oldSlots = JSON.parse(oldJson) as Record<string, number>;
      const newSlots = JSON.parse(newJson) as Record<string, number>;

      const changes: string[] = [];
      // Сортуємо ключі (00:00, 00:30...)
      const keys = Object.keys(newSlots).sort();

      let currentChangeStart: string | null = null;
      let currentChangeOldStatus: number | null = null;
      let currentChangeNewStatus: number | null = null;

      for (let i = 0; i < keys.length; i++) {
        const time = keys[i];
        const oldS = oldSlots[time];
        const newS = newSlots[time];

        // Якщо статус змінився
        if (oldS !== newS) {
          if (currentChangeStart === null) {
            // Початок блоку змін
            currentChangeStart = time;
            currentChangeOldStatus = oldS;
            currentChangeNewStatus = newS;
          } else {
            // Перевіряємо, чи продовжується той самий тип зміни
            if (oldS === currentChangeOldStatus && newS === currentChangeNewStatus) {
              // Продовжуємо блок
            } else {
              // Закриваємо попередній блок
              changes.push(this.formatDiffBlock(currentChangeStart, time, currentChangeOldStatus!, currentChangeNewStatus!));
              // Починаємо новий
              currentChangeStart = time;
              currentChangeOldStatus = oldS;
              currentChangeNewStatus = newS;
            }
          }
        } else {
          // Статус НЕ змінився. Якщо був відкритий блок змін - закриваємо його.
          if (currentChangeStart !== null) {
            changes.push(this.formatDiffBlock(currentChangeStart, time, currentChangeOldStatus!, currentChangeNewStatus!));
            currentChangeStart = null;
          }
        }
      }

      // Якщо блок змін залишився відкритим до кінця дня
      if (currentChangeStart !== null) {
        changes.push(this.formatDiffBlock(currentChangeStart, "00:00", currentChangeOldStatus!, currentChangeNewStatus!));
      }

      return changes.join('\n');
    } catch (e) {
      this.logger.error(`Error generating diff: ${e}`);
      return '';
    }
  }

  private formatDiffBlock(start: string, end: string, oldS: number, newS: number): string {
    const getEmoji = (s: number) => {
      if (s === LightStatus.ON) return EMOJ_BULB;
      if (s === LightStatus.OFF) return EMOJ_MOON;
      return EMOJ_GRAY_Q;
    };
    return `${start}-${end}: ${getEmoji(oldS)} ➔ ${getEmoji(newS)}`;
  }

  // ===================================================================
  // OUTAGE-DATA: Нова логіка роботи з outage-data-ua GitHub репозиторієм
  // ===================================================================

  /**
   * Завантажує графіки з outage-data-ua GitHub репозиторію
   * Cron: Кожні 15 хвилин зі здвигом 5 хвилин (00:05, 00:20, 00:35, 00:50)
   */
  // @Cron('5,20,35,50 * * * *')
  public async fetchOutageDataSchedules_DEPRECATED(notifyUsers: boolean = true): Promise<boolean> {
    if (this.isFetching) {
      this.logger.warn('[OutageData] Fetch already in progress. Skipping.');
      return false;
    }

    // Перевіряємо, чи налаштована GPV група
    if (!this.gpvConfigService.isConfigured()) {
      this.logger.debug('[OutageData] GPV group not configured. Skipping schedule fetch.');
      return false;
    }

    const gpvGroup = this.gpvConfigService.getGpvGroup();
    if (!gpvGroup) {
      this.logger.warn('[OutageData] GPV group is null. Skipping.');
      return false;
    }

    this.isFetching = true;
    this.logger.log(`[OutageData] Fetching schedule for GPV group: ${gpvGroup}`);

    try {
      // Завантажуємо дані з GitHub
      const rawData = await this.outageDataService.fetchKyivSchedule();
      if (!rawData) {
        this.logger.warn('[OutageData] Failed to fetch schedule from GitHub');
        return false;
      }

      // Парсимо дані для нашої групи
      const newSchedule = this.outageDataService.parseGroupSchedule(gpvGroup);
      if (!newSchedule) {
        this.logger.warn(`[OutageData] Failed to parse schedule for group ${gpvGroup}`);
        return false;
      }

      this.logger.log(`[OutageData] Successfully parsed schedule for ${gpvGroup}`);

      // Перевіряємо, чи є зміни
      const hasChanged = this.outageDataService.hasScheduleChanged(this.lastOutageSchedule, newSchedule);

      if (hasChanged && notifyUsers) {
        this.logger.log('[OutageData] Schedule has changed. Sending notification...');

        // Формуємо повідомлення
        const scheduleText = this.outageDataService.formatScheduleText(newSchedule);
        const imageUrl = this.outageDataService.getImageUrl(gpvGroup);

        const message = `🔔 **Оновлено графік відключень для групи GPV${gpvGroup}!**\n\n${scheduleText}\n\n_Останнє оновлення: ${newSchedule.updateFact || newSchedule.lastUpdated}_`;

        // Відправляємо повідомлення з зображенням
        await this.notificationBotService.sendScheduleUpdateWithImage(message, imageUrl);

        this.logger.log('[OutageData] Notification sent successfully');
      } else if (!hasChanged) {
        this.logger.log('[OutageData] Schedule has not changed. No notification needed.');
      }

      // Зберігаємо новий графік
      this.lastOutageSchedule = newSchedule;
      return true;

    } catch (error: any) {
      this.logger.error(`[OutageData] Error fetching outage-data schedule: ${error.message}`, error.stack);
      return false;
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Перевіряє чи зміна timestamp пов'язана з переходом на новий день
   */
  private isDayRollover(oldSchedule: any, newSchedule: any): boolean {
    if (!oldSchedule || !newSchedule) return false;

    const oldDate = new Date(parseInt(oldSchedule.timestamp) * 1000);
    const newDate = new Date(parseInt(newSchedule.timestamp) * 1000);

    // Перевіряємо чи oldDate це вчора, а newDate це сьогодні
    const yesterdayStart = new Date();
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    yesterdayStart.setHours(0, 0, 0, 0);

    const yesterdayEnd = new Date();
    yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);
    yesterdayEnd.setHours(23, 59, 59, 999);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const isOldYesterday = oldDate >= yesterdayStart && oldDate <= yesterdayEnd;
    const isNewToday = newDate >= todayStart && newDate <= todayEnd;

    return isOldYesterday && isNewToday;
  }
}
