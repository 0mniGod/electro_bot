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

@Cron('*/30 * * * *') // Раз на 30 хвилин
  public async fetchAndCacheSchedules(notifyUsers: boolean = true): Promise<boolean> {
  	if (this.isFetching) {
  	  this.logger.warn('[ScheduleCache] Fetch already in progress. Skipping.');
  	  return false;
  	}
  	this.isFetching = true;
  	this.logger.log(`[ScheduleCache] Fetching new schedules from ${API_URL}...`);

  	// --- 💡 ПОЧАТОК НОВОЇ ЛОГІКИ 💡 ---
  	// Наші цільові регіон та черга
  	const MY_REGION_KEY = 'kyiv';
  	const MY_QUEUE_KEY = '2.1';

  	// Допоміжна функція для витягування ТІЛЬКИ НАШОГО графіка
  	const getMyScheduleForDate = (cache: ScheduleCache | null, date: string): { json: string; hasData: boolean } => {
  		if (!cache || !cache.regions || !date) return { json: "{}", hasData: false };

  		try {
  			// 1. Знаходимо наш регіон
  			const region = cache.regions.find(r => r.cpu === MY_REGION_KEY);
  			if (!region || !region.schedule) return { json: "{}", hasData: false };

  			// 2. Знаходимо нашу чергу
  			const queueSchedule = region.schedule[MY_QUEUE_KEY];
  			if (!queueSchedule || !queueSchedule[date]) return { json: "{}", hasData: false };

  			// 3. Сортуємо ключі ЧАСУ (00:00, 00:30...)
  			const slots = queueSchedule[date];
  			const sortedTimeKeys = Object.keys(slots).sort();
  			
  			// 💡 ВИПРАВЛЕННЯ: Перевіряємо, чи є реальні дані
  			if (sortedTimeKeys.length === 0) {
  				return { json: "{}", hasData: false };
  			}
  			
  			const stableSlots = {};
  			for (const timeKey of sortedTimeKeys) {
  				stableSlots[timeKey] = slots[timeKey];
  			}
  			return { json: JSON.stringify(stableSlots), hasData: true };

  		} catch (e) {
  			this.logger.error(`[ScheduleCache] Failed to extract ${MY_REGION_KEY}/${MY_QUEUE_KEY} for ${date}`, e);
  			return { json: "{}", hasData: false }; // Повертаємо порожній об'єкт у разі помилки
  		}
  	};
  	// --- 💡 КІНЕЦЬ НОВОЇ ЛОГІКИ 💡 ---


  	try {
  	  const requestOptions = {
  	  	timeout: 45000, 
  	  	headers: {
  	  	  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36',
  	  	  'Accept-Encoding': 'identity'
  	  	},
  	  	decompress: false
  	  };
  	  
  	  this.logger.debug(`[ScheduleCache] Fetching with options: ${JSON.stringify(requestOptions)}`);

  	  const response = await firstValueFrom(
  	  	this.httpService.get<ScheduleCache>(API_URL, requestOptions)
  	  );

  	  this.logger.debug(`[ScheduleCache] Raw response status: ${response.status}`);
  	  this.logger.debug(`[ScheduleCache] Raw response data (first 200 chars): ${JSON.stringify(response.data).substring(0, 200)}...`);

  	  const responseData = response.data; 

  	  if (responseData && responseData.regions) {
  	  		  
  	  	const newTodayDate = responseData.date_today;
  	  	const newTomorrowDate = responseData.date_tomorrow;

  	  	let todayScheduleHasChanged = false;
  	  	let newScheduleForTomorrowAppeared = false;
        let rolledOverDate: string | null = null; // 💡 Зберігаємо дату, яка "переїхала"

  	  	// 1. Очищуємо старі дати (логіка з минулого разу)
  	  	this.notifiedTomorrowDates.forEach(date => {
  	  		if (date <= newTodayDate) { 
  	  			this.logger.log(`[ScheduleCache] Clearing old notified date: ${date}`);
  	  			this.notifiedTomorrowDates.delete(date);
                if (date === newTodayDate) {
                    rolledOverDate = date; // 💡 Запам'ятовуємо, що 15.11 - це вчорашнє "завтра"
                }
  	  		}
  	  	});

  	  	// 2. Перевіряємо, чи змінився графік на "СЬОГОДНІ"
  	  	const { json: oldTodaySlotsJson } = getMyScheduleForDate(this.scheduleCache, newTodayDate);
  	  	const { json: newTodaySlotsJson, hasData: newTodayHasData } = getMyScheduleForDate(responseData, newTodayDate);
  	  	
        // 💡 ВИПРАВЛЕННЯ: Повністю ігноруємо зміни "Сьогодні", якщо це дата, яка щойно "переїхала"
  	  	if (rolledOverDate === newTodayDate) {
  	  		this.logger.log(`[ScheduleCache] Today's date (${newTodayDate}) just rolled over. Suppressing "Today" change check.`);
  	  		todayScheduleHasChanged = false; // Примусово вимикаємо
  	  	}
  	  	// Перевіряємо зміни "Сьогодні" ТІЛЬКИ якщо це не "переїзд"
  	  	else if (newTodayHasData && oldTodaySlotsJson !== newTodaySlotsJson) {
  	  		 this.logger.log(`[ScheduleCache] My schedule for TODAY (${newTodayDate}) has changed or appeared.`);
  	  		 todayScheduleHasChanged = true;
  	  	} else {
  	  		 this.logger.log(`[ScheduleCache] My schedule for TODAY (${newTodayDate}) has NOT changed.`);
  	  	}


  	  	// 3. Перевіряємо, чи з'явився графік на "ЗАВТРА"
  	  	if (newTomorrowDate && !this.notifiedTomorrowDates.has(newTomorrowDate)) {
            // 💡 ВИПРАВЛЕННЯ: Використовуємо 'hasData'
  	  		const { json: newTomorrowSlotsJson, hasData: newTomorrowHasData } = getMyScheduleForDate(responseData, newTomorrowDate);
  	  		
  	  		if (newTomorrowHasData) {
                // Додатково перевіряємо, чи він не такий самий, як старий (на випадок перезапуску)
  	  			const { json: oldTomorrowSlotsJson } = getMyScheduleForDate(this.scheduleCache, newTomorrowDate);
                if (newTomorrowSlotsJson !== oldTomorrowSlotsJson) {
                     this.logger.log(`[ScheduleCache] New schedule for TOMORROW (${newTomorrowDate}) detected AND data exists. Will notify.`);
                     newScheduleForTomorrowAppeared = true;
                     this.notifiedTomorrowDates.add(newTomorrowDate);
                } else {
                     this.logger.log(`[ScheduleCache] Schedule for TOMORROW (${newTomorrowDate}) exists, but is identical to cache. Suppressing notification.`);
                     // Додаємо, щоб не перевіряти знову
                     this.notifiedTomorrowDates.add(newTomorrowDate);
                }
  	  		} else {
  	  			this.logger.log(`[ScheduleCache] 'date_tomorrow' is ${newTomorrowDate}, but no actual schedule data was found for it. Suppressing notification.`);
  	  		}
  	  	}
  	  	
  	  	// 4. Зберігаємо НОВІ дані в кеш (це тепер наша "стара" версія для наступної перевірки)
  	  	this.scheduleCache = responseData;

  	  	// 5. Логіка сповіщень
  	  	if (notifyUsers) {
  	  	  try {
  	  		const updateMessages: string[] = [];
  	  		
  	  		if (todayScheduleHasChanged) {
  	  			const dateTodayStr = format(new Date(newTodayDate), 'dd.MM');
  	  			updateMessages.push(`🔔 **Оновлено графік на сьогодні (${dateTodayStr})!**`);
  	  		}
  	  		  
  	  		if (newScheduleForTomorrowAppeared) {
  	  		  const dateTomorrowStr = format(new Date(newTomorrowDate), 'dd.MM');
  	  		  updateMessages.push(`💡 **З'явився графік на завтра (${dateTomorrowStr})!**`);
  	  		}
  	  		  
  	  		if (updateMessages.length > 0) {
  	  			const finalMessage = updateMessages.join('\n\n');
  	  			this.logger.log(`[ScheduleCache] Sending notification: "${finalMessage}"`);
  	  			await this.notificationBotService.sendScrapedNotification(finalMessage);
  	  		} else {
  	  			this.logger.log('[ScheduleCache] No significant changes found to notify.');
  	  		}
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
  	  
  	  this.logger.error(`[ScheduleCache] === FETCH FAILED ===`);
  	  if (error.isAxiosError) {
  	  	this.logger.error(`[ScheduleCache] Axios Error Code: ${error.code}`);
  	  	this.logger.error(`[ScheduleCache] Axios Status: ${error.response?.status}`);
  	  	this.logger.error(`[ScheduleCache] Axios Message: ${error.message}`);
  	  	this.logger.error(`[ScheduleCache] Request Config: ${JSON.stringify(error.config, (key, value) => key === 'data' ? undefined : value)}`);
  	  } else {
  	  	this.logger.error(`[ScheduleCache] Unknown Error: ${error}`, error instanceof Error ? error.stack : undefined);
  	  }
  	  this.logger.error(`[ScheduleCache] === END FETCH FAILED ===`);
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
   * Створює гарний рядок з графіком на сьогодні (ОНОВЛЕНО v2)
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
      
      // --- ВИПРАВЛЕНА ЛОГІКА ПОТОЧНОГО ЧАСУ ---
      const currentHour = nowKyiv.getHours();
      const currentMinute = nowKyiv.getMinutes();
      const currentTotalMinutes = currentHour * 60 + currentMinute;
      // --- --------------------------------- ---

      for (let hour = 0; hour < 24; hour++) {
        for (let minute = 0; minute < 60; minute += 30) {
          
          const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
          const slotStatus: LightStatus = slotsToday[timeStr] ?? LightStatus.UNKNOWN;
          
          let prefixEmoji: string; 
          let statusEmoji: string; 

          if (slotStatus === LightStatus.ON) {
            statusEmoji = EMOJ_BULB; // 💡
          } else if (slotStatus === LightStatus.OFF) {
            statusEmoji = EMOJ_MOON; // 🌚
          } else {
            statusEmoji = EMOJ_GRAY_Q; // ❔
          }
          
          // --- ВИПРАВЛЕНА ЛОГІКА ПОТОЧНОГО ЧАСУ ---
          const slotTotalMinutes = hour * 60 + minute;
          
          // isCurrent: Поточний час знаходиться В ЦЬОМУ 30-хв слоті
          const isCurrent = currentTotalMinutes >= slotTotalMinutes && currentTotalMinutes < (slotTotalMinutes + 30);
          // isPast: Початок слота ВЖЕ МИНУВ
          const isPast = slotTotalMinutes < currentTotalMinutes;
          // --- --------------------------------- ---

          if (isCurrent) {
            prefixEmoji = EMOJ_GREEN_CIRCLE; // 🟢
          } else if (isPast) {
            prefixEmoji = '🔙'; 
          } else {
            prefixEmoji = '🔜';
          }

          // Форматуємо: [Префікс] [Час]: [Статус]
          scheduleLines.push(`${prefixEmoji} ${timeStr}: ${statusEmoji}`);
        }
      }
      
      return this.compressScheduleText(scheduleLines);

    } catch (error) {
      this.logger.error(`[ScheduleText] Error building schedule string: ${error}`);
      return '<i>Помилка при обробці графіка.</i>';
    }
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

  
  public getTomorrowsScheduleAsText(regionKey: string, queueKey: string): string {
    if (!this.scheduleCache) {
      this.logger.warn('[ScheduleText] Schedule cache is empty.');
      return '<i>Графік на завтра ще не завантажено.</i>';
    }

    try {
      const region = this.scheduleCache.regions.find(r => r.cpu === regionKey);
      const schedule = region?.schedule[queueKey];
      const dateTomorrowStr = this.scheduleCache.date_tomorrow;
      
      if (!dateTomorrowStr) {
           return '<i>Дані на завтра ще не опубліковано.</i>';
      }
      
      const slotsTomorrow = schedule ? schedule[dateTomorrowStr] : null;

      if (!slotsTomorrow) {
        this.logger.warn(`[ScheduleText] No schedule found for ${regionKey}/${queueKey} on ${dateTomorrowStr}`);
        return '<i>Не вдалося знайти графік на завтра.</i>';
      }

      const scheduleLines: string[] = [];
      // "Завтра" - це завжди "майбутнє", тому префікс один для всіх
      const prefixEmoji = '🔜'; 

      for (let hour = 0; hour < 24; hour++) {
        for (let minute = 0; minute < 60; minute += 30) {
          
          const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
          const slotStatus: LightStatus = slotsTomorrow[timeStr] ?? LightStatus.UNKNOWN;
          
          let statusEmoji: string;

          if (slotStatus === LightStatus.ON) {
            statusEmoji = EMOJ_BULB; // 💡
          } else if (slotStatus === LightStatus.OFF) {
            statusEmoji = EMOJ_MOON; // 🌚
          } else {
            statusEmoji = EMOJ_GRAY_Q; // ❔
          }
          
          // Форматуємо рядок: 🔜 00:00: 💡
          scheduleLines.push(`${prefixEmoji} ${timeStr}: ${statusEmoji}`);
        }
      }
      
      // Використовуємо той самий компресор
      return this.compressScheduleText(scheduleLines);

    } catch (error) {
      this.logger.error(`[ScheduleText] Error building tomorrow schedule string: ${error}`);
      return '<i>Помилка при обробці графіка на завтра.</i>';
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
