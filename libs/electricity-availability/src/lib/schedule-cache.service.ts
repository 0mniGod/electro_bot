import { HttpService } from '@nestjs/axios';
import { Cron } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
//import { dt as dt_util } from 'homeassistant-util-dt'; // (Потрібно імітувати)
import { isBefore, isEqual, addMinutes, differenceInMinutes, format, startOfHour } from 'date-fns';
import { convertToTimeZone } from 'date-fns-timezone';
import { uk } from 'date-fns/locale';
import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { NotificationBotService } from '@electrobot/bot';
import {
  EMOJ_BULB,         
  EMOJ_MOON,         
  EMOJ_CHECK_MARK,   
  EMOJ_GRAY_Q,       
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
  private lastNotifiedScheduleJSON: string | null = null; 
  private notifiedTomorrowDates = new Set<string>();

constructor(
    private readonly httpService: HttpService,
    @Inject(forwardRef(() => NotificationBotService))
    private readonly notificationBotService: NotificationBotService
  ) {}
  
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
  public async fetchAndCacheSchedules(notifyUsers: boolean = true): Promise<boolean> {
    if (this.isFetching) {
      this.logger.warn('[ScheduleCache] Fetch already in progress. Skipping.');
      return false;
    }
    this.isFetching = true;
    this.logger.log(`[ScheduleCache] Fetching new schedules from ${API_URL}...`);

    try {
      // --- ДОДАНО НОВІ НАЛАШТУВАННЯ ЗАПИТУ ---
      const requestOptions = {
        timeout: 45000, // 1. Збільшено тайм-аут до 45 секунд
        headers: {
          // 2. Прикидаємось браузером
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36',
          // 3. Просимо не стискати відповідь (це може виправити Z_BUF_ERROR)
          'Accept-Encoding': 'identity'
        },
        decompress: false // 4. Кажемо axios не розархівовувати (на випадок пошкодження)
      };
      
      this.logger.debug(`[ScheduleCache] Fetching with options: ${JSON.stringify(requestOptions)}`);
      // --- --------------------------------- ---

      const response = await firstValueFrom(
        this.httpService.get<ScheduleCache>(API_URL, requestOptions)
      );

      this.logger.debug(`[ScheduleCache] Raw response status: ${response.status}`);
      // Логуємо перші 200 символів тіла, щоб не спамити
      this.logger.debug(`[ScheduleCache] Raw response data (first 200 chars): ${JSON.stringify(response.data).substring(0, 200)}...`);

      const responseData = response.data; // <--- responseData тепер тут

      if (responseData && responseData.regions) {
        
        // --- (Стара логіка порівняння JSON, залишається як була) ---
        const newJsonString = JSON.stringify(responseData);
        if (newJsonString === this.lastNotifiedScheduleJSON) {
          this.logger.log('[ScheduleCache] Fetched schedule is identical. No update needed.');
          return true; // Вважаємо успіхом, хоч і без змін
        }
        this.logger.log('[ScheduleCache] !!! Schedule change DETECTED! Updating cache... !!!');
        this.scheduleCache = responseData;
        this.lastNotifiedScheduleJSON = newJsonString;
        // --- ---------------------------------------------------- ---

        // (Логіка сповіщень, залишається як була)
        if (notifyUsers) {
          try {
            const today = this.scheduleCache.date_today;
            const dateTodayStr = format(new Date(today), 'dd.MM');
            let updateMessage = `🔔 **Оновлено графік на сьогодні (${dateTodayStr})!**`;
            
            const tomorrow = this.scheduleCache.date_tomorrow;
            if (tomorrow && !this.notifiedTomorrowDates.has(tomorrow)) {
              const dateTomorrowStr = format(new Date(tomorrow), 'dd.MM');
              updateMessage += `\n\n💡 **З'явився графік на завтра (${dateTomorrowStr})!**`;
              this.notifiedTomorrowDates.add(tomorrow);
            }
            
            // Очищуємо старі дати "завтра"
            this.notifiedTomorrowDates.forEach(date => {
              if (date < today) {
                this.notifiedTomorrowDates.delete(date);
              }
            });

            await this.notificationBotService.sendScrapedNotification(updateMessage);
          } catch (notifyError) {
             this.logger.error(`[ScheduleCache] Failed to send notification (but cache was updated): ${notifyError}`);
          }
        }
        return true; // Успіх

      } else {
        this.logger.warn('[ScheduleCache] Fetched schedule data is empty or invalid.');
        return false;
      }

    } catch (error: any) {
      
      // --- ДОДАНО РОЗШИРЕНЕ ЛОГУВАННЯ ПОМИЛОК ---
      this.logger.error(`[ScheduleCache] === FETCH FAILED ===`);
      if (error.isAxiosError) {
        this.logger.error(`[ScheduleCache] Axios Error Code: ${error.code}`);
        this.logger.error(`[ScheduleCache] Axios Status: ${error.response?.status}`);
        this.logger.error(`[ScheduleCache] Axios Message: ${error.message}`);
        // Логуємо конфіг, з яким робили запит (без тіла)
        this.logger.error(`[ScheduleCache] Request Config: ${JSON.stringify(error.config, (key, value) => key === 'data' ? undefined : value)}`);
      } else {
        this.logger.error(`[ScheduleCache] Unknown Error: ${error}`, error instanceof Error ? error.stack : undefined);
      }
      this.logger.error(`[ScheduleCache] === END FETCH FAILED ===`);
      // --- ------------------------------------ ---
      return false;

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
   * (КРОК 2)
   * Створює гарний рядок з графіком на сьогодні (ОНОВЛЕНО)
   */
  public getTodaysScheduleAsText(regionKey: string, queueKey: string): string {
    if (!this.scheduleCache) {
      this.logger.warn('[ScheduleText] Schedule cache is empty.');
      return '<i>Графік на сьогодні ще не завантажено.</i>';
    }

    try {
      const region = this.scheduleCache.regions.find(r => r.cpu === regionKey);
      const schedule = region?.schedule[queueKey];
      const dateTodayStr = this.scheduleCache.date_today;
      const slotsToday = schedule ? schedule[dateTodayStr] : null;

      if (!slotsToday) {
        this.logger.warn(`[ScheduleText] No schedule found for ${regionKey}/${queueKey} on ${dateTodayStr}`);
        return '<i>Не вдалося знайти графік для вашої групи на сьогодні.</i>';
      }

      const scheduleLines: string[] = [];
      const nowKyiv = dt_util_mock.now(TZ_KYIV);
      // Отримуємо *поточну* годину та хвилини
      const currentHour = nowKyiv.getHours();
      const currentMinute = nowKyiv.getMinutes();

      // Проходимо по всіх 48 слотах дня (00:00 ... 23:30)
      for (let hour = 0; hour < 24; hour++) {
        for (let minute = 0; minute < 60; minute += 30) {
          
          const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
          const slotStatus: LightStatus = slotsToday[timeStr] ?? LightStatus.UNKNOWN;
          
          let prefixEmoji: string; // 🔙, 🔘, 🔜
          let statusEmoji: string; // 💡, 🌚, ❔

          // 1. Визначаємо статус (світло/темрява/можливо)
          if (slotStatus === LightStatus.ON) {
            statusEmoji = EMOJ_BULB; // 💡
          } else if (slotStatus === LightStatus.OFF) {
            statusEmoji = EMOJ_MOON; // 🌚
          } else {
            statusEmoji = EMOJ_GRAY_Q; // ❔
          }
          
          // 2. Визначаємо час (минулий, поточний, майбутній)
          const isPast = hour < currentHour || (hour === currentHour && minute < currentMinute && minute < 30);
          const isCurrent = hour === currentHour && ((minute === 0 && currentMinute < 30) || (minute === 30 && currentMinute >= 30));
          
          if (isCurrent) {
            prefixEmoji = '🔘'; // Поточний
          } else if (isPast) {
            prefixEmoji = '🔙'; // Минулий
          } else {
            prefixEmoji = '🔜'; // Майбутній
          }

          // Форматуємо рядок: [Префікс] [Час]: [Статус]
          scheduleLines.push(`${prefixEmoji} ${timeStr}: ${statusEmoji}`);
        }
      }
      
      // Об'єднуємо сусідні однакові слоти для компактності
      return this.compressScheduleText(scheduleLines);

    } catch (error) {
      this.logger.error(`[ScheduleText] Error building schedule string: ${error}`);
      return '<i>Помилка при обробці графіка.</i>';
    }
  }

  /**
   * Допоміжний метод для об'єднання однакових слотів
   */
/**
   * Допоміжний метод для об'єднання однакових слотів (ОНОВЛЕНО)
   */
  private compressScheduleText(lines: string[]): string {
      if (lines.length === 0) return '';
      
      const compressed: string[] = [];
      let startLine = lines[0]; // Напр: "🔙 00:00: 💡"
      
      for (let i = 1; i < lines.length; i++) {
          const currentLine = lines[i];
          
          // Отримуємо префікс (🔙) та статус (💡)
          const startPrefix = startLine.split(' ')[0];
          const startStatus = startLine.split(' ')[2];
          const currentPrefix = currentLine.split(' ')[0];
          const currentStatus = currentLine.split(' ')[2];
          
          // Якщо префікс (минуле/майбутнє) АБО статус (світло/темрява) змінилися
          if (startPrefix !== currentPrefix || startStatus !== currentStatus) {
              // Завершуємо попередній блок
              const startTime = startLine.split(' ')[1].replace(':', ''); // "00:00"
              const endTime = currentLine.split(' ')[1].replace(':', ''); // "03:30" (початок нового)
              
              // Форматуємо: 🔙 00:00 - 03:30: 💡
              compressed.push(`${startPrefix} ${startTime} - ${endTime}: ${startStatus}`);
              
              // Починаємо новий блок
              startLine = currentLine;
          }
          // Якщо статуси однакові, просто продовжуємо цикл
      }
      
      // Додаємо останній блок (від останньої зміни до кінця дня)
      const lastPrefix = startLine.split(' ')[0];
      const lastStatus = startLine.split(' ')[2];
      const lastStartTime = startLine.split(' ')[1].replace(':', '');
      
      compressed.push(`${lastPrefix} ${lastStartTime} - 00:00: ${lastStatus}`);
      
      return compressed.join('\n');
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
