import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
//import { dt as dt_util } from 'homeassistant-util-dt'; // (Потрібно імітувати)
import { addMinutes, differenceInMinutes, format, startOfHour } from 'date-fns';
import { convertToTimeZone } from 'date-fns-timezone';
import { uk } from 'date-fns/locale';

// --- Імітація dt_util з Home Assistant ---
// (Ми не можемо імпортувати 'homeassistant-util-dt', тому створимо свою версію)
const TZ_KYIV = 'Europe/Kyiv';
const dt_util_mock = {
  now: (timeZone: string) => convertToTimeZone(new Date(), { timeZone }),
  as_utc: (date: Date) => date.toISOString(), // Просто конвертуємо в ISO UTC
};
// --- Кінець імітації ---


// API URL, який ми знайшли
const API_URL = "https://svitlo-proxy.svitlo-proxy.workers.dev";

// Стан світла (1 = є, 2 = немає, 0 = можливо)
enum LightStatus {
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

  constructor(private readonly httpService: HttpService) {}

  /**
   * Завантажує кеш при старті програми
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('Starting initial schedule cache fetch...');
    await this.fetchAndCacheSchedules();
  }

  /**
   * Завантажує великий JSON з API і зберігає в пам'яті
   * Запускається кожні 30 хвилин
   */
  @Cron('*/30 * * * *') // Раз на 30 хвилин
  public async fetchAndCacheSchedules(): Promise<void> {
    if (this.isFetching) {
      this.logger.warn('Schedule fetch already in progress. Skipping.');
      return;
    }
    this.isFetching = true;
    this.logger.log(`Fetching new schedules from ${API_URL}...`);

    try {
      const response = await firstValueFrom(
        this.httpService.get<ScheduleCache>(API_URL, { timeout: 25000 })
      );

      if (response.data && response.data.regions) {
        this.scheduleCache = response.data;
        this.logger.log(`Successfully fetched and cached schedules for ${response.data.regions.length} regions.`);
      } else {
        this.logger.warn('Fetched schedule data is empty or invalid.');
      }
    } catch (error) {
      this.logger.error(`Failed to fetch schedules: ${error}`, error instanceof Error ? error.stack : undefined);
    } finally {
      this.isFetching = false;
    }
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
   * Допоміжний метод для пошуку наступного слоту
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
            // Знайшли! Повертаємо час початку цього слоту
            return slotTime;
        }
    }

    return undefined; // Не знайдено
  }
}
