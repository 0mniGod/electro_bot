import { Place } from '@electrobot/domain';
import { PlaceRepository } from '@electrobot/place-repo'; // Залишаємо для onModuleInit
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, OnModuleInit, forwardRef, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  addHours,
  addMinutes,
  addMonths,
  differenceInMinutes,
  eachDayOfInterval,
  endOfDay,
  endOfMonth,
  format,
  formatDistance,
  getDay,
  getMonth,
  startOfDay,
  startOfMonth,
  subMinutes,
  isBefore,
  subDays,
  isEqual,  
  startOfHour, 
} from 'date-fns'; // Додано isBefore, subDays
import { convertToTimeZone } from 'date-fns-timezone';
import { uk } from 'date-fns/locale';
import { firstValueFrom } from 'rxjs';
import { HistoryItem } from './history-item.type';
import { ScheduleCacheService } from './schedule-cache.service';
import {
  NotificationBotService,
  RESP_ENABLED_SHORT,
  RESP_DISABLED_SHORT,
  RESP_ENABLED_SUSPICIOUS,
  RESP_ENABLED_DETAILED,
  RESP_DISABLED_SUSPICIOUS,
  RESP_DISABLED_DETAILED,
  EXPECTED_DISABLE_MOMENT,
  EXPECTED_ENABLE_MOMENT
} from '@electrobot/bot';
// import { ElectricityRepository } from './electricity.repository'; // <--- ВИДАЛЕНО

const MIN_SUSPICIOUS_DISABLE_TIME_IN_MINUTES = 30;
const API_KEY = 'demo';

// Інтерфейс для запису в історію
interface HistoryRecord {
  time: Date;
  is_available: boolean;
  placeId: string;
}

  const HARDCODED_PLACE_FOR_EA: Place = {
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

@Injectable()
export class ElectricityAvailabilityService implements OnModuleInit {
  private readonly logger = new Logger(ElectricityAvailabilityService.name);
  private static isCronRunning = false;

  // --- КЕШ В ПАМ'ЯТІ ---
  private cachedPlaces: Place[] = [];
  private lastKnownStatus: Record<string, boolean> = {};
  // --- ІСТОРІЯ В ПАМ'ЯТІ ---
  private history: HistoryRecord[] = [];
  private readonly MAX_HISTORY_DAYS = 3; // Зберігаємо історію за 3 дні
  // --- -------------------- ---

  constructor(
    // --- ВИДАЛЕНО ElectricityRepository ---
    //private readonly placeRepository: PlaceRepository,
    private readonly httpService: HttpService,
    @Inject(forwardRef(() => ScheduleCacheService)) 
    private readonly scheduleCacheService: ScheduleCacheService,
    @Inject(forwardRef(() => NotificationBotService))
    private readonly notificationBotService: NotificationBotService,
  ) {
    this.logger.log('ElectricityAvailabilityService initialized (Database connection REMOVED).');
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('ElectricityAvailabilityService onModuleInit started.');
    await this.refreshInternalCache();
    this.logger.log('ElectricityAvailabilityService onModuleInit finished.');
  }
  
public async refreshInternalCache(): Promise<void> {
    this.logger.log('[Cache] Starting internal cache refresh from hardcode...');
    try {
      // 1. Використовуємо хардкод
      this.cachedPlaces = [HARDCODED_PLACE_FOR_EA]; 
      this.logger.log(`[Cache] Loaded ${this.cachedPlaces.length} places from hardcode.`);

      // 2. Скидаємо кеш статусів
      this.lastKnownStatus = {};
      this.history = []; // Очищуємо історію
      this.logger.log('[Cache] In-memory history and statuses cleared.');

    } catch (error) {
      this.logger.error(`[Cache] Failed to refresh internal cache: ${error}`, error instanceof Error ? error.stack : undefined);
    }
    this.logger.log('[Cache] Internal cache refresh finished.');
  }

  // ... (методи sleep, pingKoyebApp, checkWithRetries, checkViaCheckHost, checkViaViewDNS, check залишаються БЕЗ ЗМІН) ...
  // --- НОВИЙ ДОПОМІЖНИЙ МЕТОД ---
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async pingKoyebApp(): Promise<void> {
    // Беремо URL зі змінних оточення, які ви додали на Koyeb
    const url = process.env.KOYEB_APP_URL; 
    
    if (!url) {
        this.logger.warn('KOYEB_APP_URL is not set. Skipping keep-alive ping.');
        return;
    }

    this.logger.verbose(`Sending keep-alive ping to ${url}...`);
    try {
        // Просто робимо GET-запит до себе
        await firstValueFrom(
            this.httpService.get(url, { 
                timeout: 10000, // 10-секундний тайм-аут
                headers: { 'User-Agent': 'Koyeb Electro Bot Keep-Alive' } 
            })
        );
        this.logger.verbose('Keep-alive ping successful.');
    } catch (error: any) {
        this.logger.warn(`Keep-alive ping to ${url} failed. Error: ${error.message}`);
    }
  }
  
  // --- НОВИЙ МЕТОД З ПОВТОРНИМИ СПРОБАМИ ---
  private async checkWithRetries(place: Place): Promise<{
    readonly place: Place;
    readonly isAvailable: boolean;
  }> {
    const retries = 5; // 5 спроби
    const delay = 10000; // 10 секунд між спробами

    for (let i = 1; i <= retries; i++) {
      this.logger.verbose(`Check attempt ${i}/${retries} for ${place.host}`);
      const { isAvailable } = await this.check(place);
      
      if (isAvailable) {
        // Успіх
        return { place, isAvailable: true };
      }
      
      if (i < retries) {
        this.logger.warn(`Check attempt ${i} failed. Retrying in ${delay / 1000}s...`);
        await this.sleep(delay);
      }
    }

    // Якщо всі 3 спроби не вдалися
    this.logger.warn(`All ${retries} check attempts failed for ${place.host}. Reporting as UNAVAILABLE.`);
    return { place, isAvailable: false };
  }
  // --- КІНЕЦЬ НОВИХ МЕТОДІВ ---

/**
   * Cервіс B: Перевірка через check-host.net (з ВИПРАВЛЕНОЮ логікою перевірки "OK")
   */
  private async checkViaCheckHost(host: string): Promise<boolean> {
    this.logger.verbose(`[CheckHost] Starting PING check for ${host} (EU)...`);
    
    // --- 1. Визначимо вузли ---
    const nodes = ['de1.node.check-host.net', 'fr1.node.check-host.net', 'pl1.node.check-host.net'];
    
    // --- 2. Запит на перевірку ---
    const nodeParams = nodes.map(n => `node=${n}`).join('&');
    const requestUrl = `https://check-host.net/check-ping?host=${host}&${nodeParams}`;
    let requestId: string;

    try {
      this.logger.debug(`[CheckHost] Requesting check via URL: ${requestUrl}`);
      const requestResponse = await firstValueFrom(
        this.httpService.get(requestUrl, {
          timeout: 10000,
          headers: { 'Accept': 'application/json' } 
        })
      );
      this.logger.debug(`[CheckHost] Request Response Data: ${JSON.stringify(requestResponse.data)}`);
      if (requestResponse.data.ok === 1 && requestResponse.data.request_id) {
        requestId = requestResponse.data.request_id;
        this.logger.log(`[CheckHost] Got request_id: ${requestId}`);
      } else {
        throw new Error(requestResponse.data.error || 'Failed to request check (Invalid response)');
      }
    } catch (error: any) {
      this.logger.error(`[CheckHost] (Request phase) FAILED: ${error.message}`);
      return false; // Провал на етапі 1
    }

    this.logger.verbose(`[CheckHost] Starting polling for ${requestId} (max 30s)...`);
    
    // --- 3. КОРЕКТНА ЛОГІКА ПУЛІНГУ ---
    const resultUrl = `https://check-host.net/check-result/${requestId}`;
    const maxAttempts = 5; 
    const pollInterval = 6000; // 6 секунд

    for (let i = 1; i <= maxAttempts; i++) {
      await this.sleep(pollInterval); 
      this.logger.verbose(`[CheckHost] Poll attempt ${i}/${maxAttempts} for ${requestId}...`);

      let results;
      try {
        this.logger.debug(`[CheckHost] Polling results via URL: ${resultUrl}`);
        const resultResponse = await firstValueFrom(
          this.httpService.get(resultUrl, {
            timeout: 10000,
            headers: { 'Accept': 'application/json' }
          })
        );
        results = resultResponse.data;
        this.logger.debug(`[CheckHost] Poll Response Data (attempt ${i}): ${JSON.stringify(results)}`);

      } catch (error: any) {
        this.logger.warn(`[CheckHost] (Polling attempt ${i}) http error: ${error.message}`);
        continue; // Помилка http, але ми продовжуємо цикл
      }

      // 1. ПЕРЕВІРЯЄМО НА "OK" (УСПІХ) - ВИПРАВЛЕНА ЛОГІКА
      if (results) { 
        let foundOK = false;
        for (const node of nodes) {
          // *** ОСЬ ВИПРАВЛЕННЯ: Додано [0] ***
          if (results[node] && results[node][0] && results[node][0][0] && results[node][0][0][0] === 'OK') {
            this.logger.log(`[CheckHost] >>> SUCCESS found on attempt ${i} from node ${node}!`);
            foundOK = true;
            break; // Знайшли "OK", виходимо з внутрішнього циклу for
          }
        }
        if (foundOK) {
            return true; // !!! УСПІХ! Виходимо з функції.
        }
      }

      // 2. "OK" НЕ ЗНАЙДЕНО НА ЦІЙ СПРОБІ.
      //    Перевіряємо, чи тест *точно* завершився з помилкою,
      //    чи він ще триває.

      // 2a. Перевіряємо, чи всі вузли вже відзвітували
      let allNodesReported = results !== null;
      if (allNodesReported) {
        for (const node of nodes) {
          if (!results[node]) { // Якщо `results['de1...']` не існує
            allNodesReported = false;
            break; 
          }
        }
      }

      // 2b. Всі вузли відзвітували, але "OK" не було (значить, TIMEOUT)
      if (allNodesReported) {
        this.logger.warn(`[CheckHost] Test COMPLETED on attempt ${i}, but no 'OK' found (result was TIMEOUT/FAILED).`);
        return false; // !!! ПРОВАЛ! Тест завершено з помилкою.
      }
      
      // 2c. Тест ще триває (null або не всі вузли)
      if (i < maxAttempts) {
        this.logger.verbose(`[CheckHost] Results not complete on attempt ${i}. Continuing poll...`);
        // Цикл for автоматично продовжиться
      }
    }

    // 3. (Провал) Ми вийшли з циклу (пройшли всі 5 спроб)
    this.logger.error(`[CheckHost] FAILED: Polling timed out after 30s.`);
    return false;
  }
  
  /**
   * Cервіс A: Перевірка через ViewDNS (це ваш старий код, перенесений сюди)
   */
  private async checkViaViewDNS(host: string): Promise<boolean> {
    const url = `https://api.viewdns.info/ping/v2/?host=${host}&apikey=${API_KEY}&output=json`;
    this.logger.verbose(`Starting PING check for ${host} via ViewDNS API...`);

    try {
        const response = await firstValueFrom(
            this.httpService.get(url, { 
                timeout: 15000, 
                headers: { 'User-Agent': 'Koyeb Electro Bot Check' } 
            })
        );
        
        if (response.data && response.data.response && response.data.response.detail) {
            const europeRegion = response.data.response.detail.find(
                (region: any) => region.region === 'Europe'
            );

            if (europeRegion && europeRegion.locations && europeRegion.locations.length > 0) {
                const isAnyEuropeLocationOK = europeRegion.locations.some(
                    (loc: any) => loc.packet_loss !== '100%'
                );
                
                if (isAnyEuropeLocationOK) {
                    this.logger.debug(`ViewDNS check successful for ${host} from Europe.`);
                    return true;
                } else {
                    this.logger.warn(`ViewDNS check failed (Europe locations reported packet loss) for ${host}.`);
                    return false;
                }
            } else {
                this.logger.warn(`ViewDNS check failed (No 'Europe' region found in API response) for ${host}.`);
                return false;
            }
        } else {
            this.logger.error(`PING check via ViewDNS API failed (Invalid JSON response).`);
            return false;
        }
    } catch (error: any) {
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.response?.status === 504) {
            this.logger.warn(`PING check via ViewDNS API timed out for ${host}.`);
        } else {
            this.logger.error(`PING check via ViewDNS API failed (HTTP Error) for ${host}. Error: ${error.message}`);
        }
        return false;
    }
  }

  /**
   * Головний метод check, який тепер викликає A і B
   */
 private async check(place: Place): Promise<{
    readonly place: Place;
    readonly isAvailable: boolean;
  }> {
    const host = place.host;
    this.logger.verbose(`Starting DUAL check for ${host}... (ViewDNS + CheckHost.net)`);

    // Запускаємо обидві перевірки паралельно
    const results = await Promise.allSettled([
      this.checkViaViewDNS(host),      // Сервіс A (Європа)
      this.checkViaCheckHost(host)     // Сервіс B, теж Європа
    ]);

    // Аналізуємо результати
    const isViewDNSOK = results[0].status === 'fulfilled' && results[0].value === true;
    const isCheckHostOK = results[1].status === 'fulfilled' && results[1].value === true;

    // Логіка: Світло Є, якщо ХОЧА Б ОДИН сервіс це підтвердив
    const isAvailable = isViewDNSOK || isCheckHostOK; 

    if (isAvailable) {
      this.logger.log(`DUAL check SUCCESS for ${host} (ViewDNS: ${isViewDNSOK}, CheckHost: ${isCheckHostOK})`);
    } else {
      this.logger.warn(`DUAL check FAILED for ${host} (ViewDNS: ${isViewDNSOK}, CheckHost: ${isCheckHostOK})`);
    }

    return { place, isAvailable };
  }
  

  /**
   * Cron Job (без змін, використовує кеш)
   */
  @Cron('*/3 * * * *', { name: 'check-electricity-availability' })
  public async checkAndSaveElectricityAvailabilityStateOfAllPlaces(): Promise<void> {
    if (ElectricityAvailabilityService.isCronRunning) {
      this.logger.warn('Cron job "check-electricity-availability" is already running. Skipping this run.');
      return;
    }
    ElectricityAvailabilityService.isCronRunning = true;
    this.logger.log('Cron job "check-electricity-availability" (checkAndSave...) started.');
    await this.pingKoyebApp();

    try {
      const placesToCheck = this.cachedPlaces;
      if (!placesToCheck || placesToCheck.length === 0) {
        this.logger.warn('[Cron] Cached places list is empty. Attempting to refresh cache now...');
        await this.refreshInternalCache(); // Спробуємо оновити кеш
        const refreshedPlaces = this.cachedPlaces;
        if (!refreshedPlaces || refreshedPlaces.length === 0) {
          this.logger.error('[Cron] Failed to load places even after cache refresh. Skipping check cycle.');
          return;
        }
        this.logger.debug(`[Cron] Using ${refreshedPlaces.length} places from refreshed cache.`);
      } else {
        this.logger.debug(`[Cron] Checking ${placesToCheck.length} places from cache.`);
      }

      await Promise.all(placesToCheck.map(async (place) => {
        if (!place) {
            this.logger.warn('[Cron] Encountered null/undefined place in cached list. Skipping.');
            return;
        }
        if (place.isDisabled) {
          this.logger.debug(`[Cron] Skipping disabled place ${place.name} (${place.id}) from cache.`);
          return;
        }
        this.logger.debug(`[Cron] Checking place ${place.name} (${place.id})...`);
        const { isAvailable: currentAvailability } = await this.checkWithRetries(place);
        const previousAvailabilityInCache = this.lastKnownStatus[place.id];

        if (previousAvailabilityInCache === undefined || previousAvailabilityInCache !== currentAvailability) {
           this.logger.log(`[Cron] State change DETECTED for ${place.name} (${place.id}): ${previousAvailabilityInCache} -> ${currentAvailability}. Handling change...`);
           await this.handleAvailabilityChange({ place, isAvailable: currentAvailability });
        } else {
           this.logger.debug(`[Cron] State for ${place.name} (${place.id}) has NOT changed (${currentAvailability}). Skipping handler.`);
        }
      }));
    } catch (error) {
      this.logger.error(`[Cron] Error during check: ${error}`, error instanceof Error ? error.stack : undefined);
    } finally {
      ElectricityAvailabilityService.isCronRunning = false;
      this.logger.log('Cron job "check-electricity-availability" lock released.');
    }
  }

/**
   * ОНОВЛЕНИЙ: Зберігає стан, генерує "розумні" сповіщення
   * і викликає NotificationBotService для відправки.
   */
  private async handleAvailabilityChange(params: {
    readonly place: Place;
    readonly isAvailable: boolean;
  }): Promise<void> {
    const { place, isAvailable: currentAvailability } = params;
    if (!place) {
      this.logger.error('handleAvailabilityChange called with undefined place.');
      return;
    }
    this.logger.log(`Handling availability change for ${place.name}: ${currentAvailability ? 'AVAILABLE' : 'UNAVAILABLE'}`);

    try {
      // --- 1. Логіка збереження в пам'ять (як і раніше) ---
      this.logger.log(`[In-Memory] Saving new state to memory: ${currentAvailability}`);
      this.lastKnownStatus[place.id] = currentAvailability;
      this.logger.log(`[Cache] Updated lastKnownStatus for ${place.id} to ${currentAvailability}`);
      this.history.push({
        placeId: place.id,
        time: new Date(),
        is_available: currentAvailability,
      });
      this.pruneHistory();
      
      this.logger.log(`Triggering notification for place ${place.id}`);
      
      // --- 2. Логіка генерації сповіщення (з новими правилами) ---
      try {
        const [latest, previous] = await this.getLatestPlaceAvailability({
            placeId: place.id,
            limit: 2,
        });

        if (!latest) {
          this.logger.error(`[Notify] Cannot notify for ${place.id}, 'latest' state is missing from in-memory history.`);
          return;
        }

        // --- 3. Отримуємо графік (Hardcoded) ---
        let scheduleEnableMoment: Date | undefined;
        let schedulePossibleEnableMoment: Date | undefined;
        let scheduleDisableMoment: Date | undefined;
        let schedulePossibleDisableMoment: Date | undefined;
        let scheduleContextMessage = ''; // <--- Наша нова змінна
        const nowKyiv = convertToTimeZone(new Date(), { timeZone: place.timezone });

        const PLACE_ID_TO_SCHEDULE = "001"; 
        const REGION_KEY = "kyiv";
        const QUEUE_KEY = "2.1"; 

        if (place.id === PLACE_ID_TO_SCHEDULE) {
          try {
              // --- 3a. Отримуємо прогноз з кешу ---
              const prediction = this.scheduleCacheService.getSchedulePrediction(REGION_KEY, QUEUE_KEY);
              scheduleEnableMoment = prediction.scheduleEnableMoment;
              schedulePossibleEnableMoment = prediction.schedulePossibleEnableMoment;
              scheduleDisableMoment = prediction.scheduleDisableMoment;
              schedulePossibleDisableMoment = prediction.schedulePossibleDisableMoment;

              // --- 3b. АНАЛІЗ ДЛЯ КОНТЕКСТУ ---
              if (!latest.is_available) {
                // --- СВІТЛО ВИМКНУЛИ ---
                // Шукаємо ОСТАННЮ заплановану подію, а не наступну
                const lastScheduledChange = this.scheduleCacheService.findLastScheduledChange(nowKyiv, REGION_KEY, QUEUE_KEY);

                if (lastScheduledChange.time && lastScheduledChange.status === LightStatus.OFF) {
                  // > 0 = сталося ПІЗНІШЕ графіка (21:59 - 20:30 = 89 хв)
                  // < 0 = сталося РАНІШЕ графіка
                  const diffInMinutes = differenceInMinutes(latest.time, lastScheduledChange.time);
                  
                  if (diffInMinutes >= -30 && diffInMinutes <= 30) { // Вчасно (з похибкою 30 хв)
                    scheduleContextMessage = 'ℹ️ Вимкнення відбулося за графіком.';
                  } else if (diffInMinutes < -30 && diffInMinutes >= -120) { // Раніше (30-120 хв)
                    scheduleContextMessage = '🤬 Вимкнули раніше графіка. Клята русня!';
                  } else if (diffInMinutes < -120) { // Дуже рано (> 120 хв)
                    scheduleContextMessage = '🚨 Схоже, це екстрене відключення (вимкнули >2 годин до графіка). Клята русня!';
                  } else if (diffInMinutes > 30) { // Значно пізніше (як у вашому випадку 89 хв)
                    scheduleContextMessage = 'ℹ️ Вимкнення відбулося значно пізніше графіка.';
                  }
                } else {
                  scheduleContextMessage = '🚨 Увага! Вимкнення поза графіком.';
                }
              } else {
                // --- СВІТЛО ВВІМКНУЛИ ---
                const lastScheduledChange = this.scheduleCacheService.findLastScheduledChange(nowKyiv, REGION_KEY, QUEUE_KEY);
                
                if (lastScheduledChange.time && lastScheduledChange.status === LightStatus.ON) {
                  // > 0 = сталося ПІЗНІШЕ графіка
                  // < 0 = сталося РАНІШЕ графіка
                  const diffInMinutes = differenceInMinutes(latest.time, lastScheduledChange.time);
                  
                  if (diffInMinutes < -120) { // Дуже рано
                    scheduleContextMessage = '🙏💡 Світло дали БІЛЬШЕ НІЖ НА 2 ГОДИНИ раніше графіка! Слава Богу та Енергетикам!';
                  } else if (diffInMinutes < -30) { // Рано (30-120 хв)
                    scheduleContextMessage = '💡 Світло дали раніше графіка! Слава Енергетикам!';
                  } else if (diffInMinutes >= -30 && diffInMinutes <= 30) { // Вчасно
                    scheduleContextMessage = 'ℹ️ Увімкнення відбулося за графіком.';
                  }
                  // (Якщо > 30 - ввімкнули пізніше, нічого не кажемо)
                }
              }
              // --- КІНЕЦЬ АНАЛІЗУ ДЛЯ КОНТЕКСТУ ---

          } catch (scheduleError) {
               this.logger.error(`[Schedule] Failed to get prediction for notification: ${scheduleError}`);
          }
        }
        // --- ------------------------- ---

        // --- 4. Формуємо саме повідомлення ---
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
        
        // 5. Викликаємо NotificationBotService
        await this.notificationBotService.sendBulkNotificationsToPlace(place.id, response);

      } catch (notifyError) {
          this.logger.error(`[Notify] Error during notification generation for ${place.id}: ${notifyError}`);
      }
      
    } catch (error) {
      this.logger.error(`Error in handleAvailabilityChange for ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
    }
  }

  /**
   * Новий метод: Очищує історію в пам'яті, залишаючи лише MAX_HISTORY_DAYS
   */
  private pruneHistory(): void {
    const cutoffDate = subDays(new Date(), this.MAX_HISTORY_DAYS);
    const originalCount = this.history.length;
    
    this.history = this.history.filter(record => 
      isBefore(cutoffDate, record.time)
    );
    
    const removedCount = originalCount - this.history.length;
    if (removedCount > 0) {
      this.logger.log(`[Cache] Pruned ${removedCount} old history records (older than ${this.MAX_HISTORY_DAYS} days).`);
    }
  }


  /**
   * ОНОВЛЕНИЙ: Читає з історії в пам'яті
   */
  public async getLatestPlaceAvailability(params: {
    readonly placeId: string;
    readonly limit: number;
    readonly to?: Date;
  }): Promise<ReadonlyArray<HistoryRecord>> {
    this.logger.debug(`[In-Memory] Getting latest availability for place ${params.placeId} (limit ${params.limit})`);
    
    // Фільтруємо історію за placeId та (опціонально) датою 'to'
    const placeHistory = this.history
      .filter(r => r.placeId === params.placeId)
      .filter(r => (params.to ? isBefore(r.time, params.to) : true))
      .sort((a, b) => b.time.getTime() - a.time.getTime()); // Сортуємо: новіші спочатку
      
    // Повертаємо потрібну кількість записів
    return placeHistory.slice(0, params.limit);
  }

  // --- МЕТОДИ ДЛЯ СТАТИСТИКИ (getTodayAndYesterdayStats, getMonthStats, і т.д.) ---
  // --- ЗАЛИШАЮТЬСЯ БЕЗ ЗМІН, АЛЕ ТЕПЕР ВОНИ ЗАЛЕЖАТЬ ВІД getHistory (ЯКИЙ МИ НЕ ЗМІНЮВАЛИ) ---
  // --- НАМ ПОТРІБНО ПЕРЕПИСАТИ getHistory АБО МЕТОДИ, ЩО ЙОГО ВИКОРИСТОВУЮТЬ ---

  // --- ПЕРЕПИСУЄМО getTodayAndYesterdayStats, getMonthStats ---

  /**
   * ОНОВЛЕНИЙ: Читає з історії в пам'яті
   */
  public async getTodayAndYesterdayStats(params: {
    readonly place: Place;
  }): Promise<{
    readonly history: {
      readonly today: ReadonlyArray<HistoryItem>;
      readonly yesterday: ReadonlyArray<HistoryItem>;
    };
    readonly lastStateBeforeToday?: boolean;
    readonly lastStateBeforeYesterday?: boolean;
  }> {
    const { place } = params;
    if (!place) {
      this.logger.error('getTodayAndYesterdayStats called with undefined place.');
      return { history: { today: [], yesterday: [] } };
    }
    this.logger.debug(`[In-Memory] Getting today/yesterday stats for place ${place.id}`);
    
    const now = convertToTimeZone(new Date(), { timeZone: place.timezone });
    const todayStart = startOfDay(now);
    const yesterdayStart = startOfDay(subDays(now, 1)); // startOfDay(addHours(todayStart, -2)) було неправильним
    const yesterdayEnd = endOfDay(yesterdayStart);

    // Отримуємо історію з пам'яті
    const fullHistory = this.history
      .filter(r => r.placeId === place.id)
      .sort((a, b) => a.time.getTime() - b.time.getTime()); // Сортуємо: старіші спочатку

    const todayHistory = this.buildStatsFromHistory(fullHistory, todayStart, now);
    const yesterdayHistory = this.buildStatsFromHistory(fullHistory, yesterdayStart, yesterdayEnd);

    // Отримуємо останній стан ДО сьогодні
    const lastBeforeToday = fullHistory.filter(r => isBefore(r.time, todayStart)).pop();
    // Отримуємо останній стан ДО вчора
    const lastBeforeYesterday = fullHistory.filter(r => isBefore(r.time, yesterdayStart)).pop();

    return {
      history: {
        today: todayHistory,
        yesterday: yesterdayHistory,
      },
      lastStateBeforeToday: lastBeforeToday?.is_available,
      lastStateBeforeYesterday: lastBeforeYesterday?.is_available,
    };
  }

  /**
   * ОНОВЛЕНИЙ: Читає з історії в пам'яті
   */
  public async getMonthStats(params: {
    readonly place: Place;
    readonly dateFromTargetMonth: Date;
  }): Promise<{
    readonly totalMinutesAvailable: number;
    readonly totalMinutesUnavailable: number;
  }> {
    const { place, dateFromTargetMonth } = params;
    // ... (перевірка place || !dateFromTargetMonth) ...
    this.logger.debug(`[In-Memory] Getting month stats for place ${place.id}, month: ${format(dateFromTargetMonth, 'yyyy-MM')}`);
    
    const start = convertToTimeZone(startOfMonth(dateFromTargetMonth), { timeZone: place.timezone });
    const end = convertToTimeZone(endOfMonth(dateFromTargetMonth), { timeZone: place.timezone });

    const fullHistory = this.history
      .filter(r => r.placeId === place.id)
      .sort((a, b) => a.time.getTime() - b.time.getTime()); // Сортуємо: старіші спочатку
      
    const monthHistoryItems = this.buildStatsFromHistory(fullHistory, start, end);
    
    let totalMinutesAvailable = 0;
    let totalMinutesUnavailable = 0;

    monthHistoryItems.forEach(({ start, end, isEnabled }) => {
      let durationInMinutes = 0;
      try {
        durationInMinutes = Math.abs(differenceInMinutes(new Date(end), new Date(start)));
      } catch (diffError) { return; }
      
      if (isEnabled) {
        totalMinutesAvailable += durationInMinutes;
      } else {
        totalMinutesUnavailable += durationInMinutes;
      }
    });

    return { totalMinutesAvailable, totalMinutesUnavailable };
  }

  /**
   * Новий допоміжний метод для побудови статистики з масиву історії
   */
  private buildStatsFromHistory(history: HistoryRecord[], from: Date, to: Date): HistoryItem[] {
    const relevantHistory = history.filter(r => 
      r.time.getTime() >= from.getTime() && r.time.getTime() <= to.getTime()
    );

    // Знаходимо останній стан ДО початку періоду
    const lastStateBefore = history.filter(r => isBefore(r.time, from)).pop();

    const items: HistoryItem[] = [];
    let lastTime = from;
    let lastState = lastStateBefore?.is_available ?? false; // Початковий стан на початок періоду

    // Додаємо перший (початковий) елемент
    if (relevantHistory.length === 0) {
      // Якщо за період нічого не сталося, весь період був в одному стані
      items.push({ start: from, end: to, isEnabled: lastState });
    } else {
      // Додаємо відрізок від початку (from) до першої події
      items.push({
        start: from,
        end: relevantHistory[0].time,
        isEnabled: lastState
      });

      // Ітеруємо по подіях
      for (let i = 0; i < relevantHistory.length; i++) {
        const currentEvent = relevantHistory[i];
        const nextEvent = relevantHistory[i+1];

        if (nextEvent) {
          // Від поточної події до наступної
          items.push({
            start: currentEvent.time,
            end: nextEvent.time,
            isEnabled: currentEvent.is_available
          });
        } else {
          // Від останньої події до кінця періоду (to)
          items.push({
            start: currentEvent.time,
            end: to,
            isEnabled: currentEvent.is_available
          });
        }
      }
    }
    return items;
  }


  // --- (getTodayAndYesterdayStats та getMonthStats вже оновлені) ---
  // --- (getMonthStatsMessage, getDayStats, getDaysStats, getDayOffGroups автоматично почнуть працювати,
  //      оскільки вони залежать від getTodayAndYesterdayStats та getMonthStats) ---
  
  // (Методи getMonthStatsMessage, getDayStats, getDaysStats, getDayOffGroups залишаються без змін,
  //  але getDayStats потребуватиме оновлення, оскільки він викликав electricityRepository.getHistory)

  /**
   * ОНОВЛЕНИЙ: Читає з історії в пам'яті
   */
  public async getDayStats(params: {
    readonly place: Place;
    readonly date: Date;
  }): Promise<ReadonlyArray<HistoryItem>> {
    const { place, date } = params;
    if (!place || !date) {
      this.logger.error('getDayStats called with undefined params.');
      return [];
    }
    this.logger.debug(`[In-Memory] Getting day stats for place ${place.id}, date: ${format(date, 'yyyy-MM-dd')}`);
    
    const start = convertToTimeZone(startOfDay(date), { timeZone: place.timezone });
    const end = convertToTimeZone(endOfDay(date), { timeZone: place.timezone });

    const fullHistory = this.history
      .filter(r => r.placeId === place.id)
      .sort((a, b) => a.time.getTime() - b.time.getTime());

    return this.buildStatsFromHistory(fullHistory, start, end);
  }

  // (Методи getMonthStatsMessage, getDaysStats, getDayOffGroups тепер теж мають працювати)
  public async getMonthStatsMessage(params: {
    readonly place: Place;
    readonly dateFromTargetMonth: Date;
  }): Promise<string> {
    if (!params.place) {
        this.logger.error('getMonthStatsMessage called with undefined place.');
        return '';
    }
    this.logger.debug(`Getting month stats message for place ${params.place.id}`);
    try {
        // !!! ВИПРАВЛЕННЯ: Викликаємо getMonthStats !!!
        const { totalMinutesAvailable, totalMinutesUnavailable } =
          await this.getMonthStats(params);

        const totalMinutes = totalMinutesAvailable + totalMinutesUnavailable;
        if (totalMinutes === 0) {
          this.logger.warn(`Total minutes for month stats message is zero for place ${params.place.id}`);
          return ''; 
        }

        const percentAvailable = Math.round(
          (100 * totalMinutesAvailable) / totalMinutes
        );
        const percentUnavailable = 100 - percentAvailable;
        const baseDate = convertToTimeZone(new Date(), {
          timeZone: params.place.timezone,
        });
        const baseDatePlusAvailable = addMinutes(
          baseDate,
          totalMinutesAvailable
        );
        const howLongAvailable = formatDistance(baseDate, baseDatePlusAvailable, {
          locale: uk,
          includeSeconds: false,
        });
        const baseDatePlusUnavailable = addMinutes(
          baseDate,
          totalMinutesUnavailable
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

        return `У ${mn} ми насолоджувалися світлом ${percentAvailable}% часу (сумарно ${howLongAvailable}) і потерпали від темряви ${percentUnavailable}% часу (сумарно ${howLongUnavailable}).`;
    } catch (error) {
         this.logger.error(`Error in getMonthStatsMessage for ${params.place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
         return '';
    }
  }

  public async getDaysStats(params: {
    readonly place: Place;
    readonly dateFrom: Date;
    readonly dateTo: Date;
  }): Promise<
    Record<
      string,
      ReadonlyArray<{
        readonly start: Date;
        readonly end: Date;
        readonly isEnabled: boolean;
      }>
    >
  > {
    const { place, dateFrom, dateTo } = params;
    if (!place || !dateFrom || !dateTo) {
        this.logger.error('getDaysStats called with undefined params.');
        return {};
    }
    this.logger.debug(`Getting stats for ${place.id} from ${format(dateFrom, 'yyyy-MM-dd')} to ${format(dateTo, 'yyyy-MM-dd')}`);
    try {
        const days = eachDayOfInterval({ start: dateFrom, end: dateTo });
        const result: Record<
          string,
          ReadonlyArray<{
            readonly start: Date;
            readonly end: Date;
            readonly isEnabled: boolean;
          }>
        > = {};

        for (const day of days) {
          const dayStats = await this.getDayStats({ place, date: day });
          result[format(day, 'yyyy-MM-dd')] = dayStats;
        }

        return result;
    } catch (error) {
         this.logger.error(`Error in getDaysStats for ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
         return {};
    }
  }
  public async getDayOffGroups(params: {
    readonly place: Place;
    readonly date: Date;
  }): Promise<ReadonlyArray<number>> {
    const { place, date } = params;
    if (!place || !date) {
        this.logger.error('getDayOffGroups called with undefined params.');
        return [];
    }
    this.logger.debug(`Getting day off groups for place ${place.id}, date: ${format(date, 'yyyy-MM-dd')}`);
    const dayOfWeek = getDay(date); // 0 - Неділя, 1 - Понеділок ... 6 - Субота
    const dayStats = await this.getDayStats({ place, date });
    
    if (!dayStats) { // Додано перевірку
        this.logger.error(`getDayStats returned undefined for place ${place.id} in getDayOffGroups`);
        return [];
    }
    
    if (dayStats.length === 1 && !dayStats[0].isEnabled) {
        this.logger.log(`Place ${place.id} was OFF all day on ${format(date, 'yyyy-MM-dd')}. Returning group 0.`);
        return [0]; 
    }
    
    if (dayStats.length === 1 && dayStats[0].isEnabled) {
        this.logger.log(`Place ${place.id} was ON all day on ${format(date, 'yyyy-MM-dd')}. Returning group 4.`);
        return [4]; 
    }

    if (dayOfWeek >= 1 && dayOfWeek <= 5) {
      if (dayStats.length === 3) { 
        this.logger.log(`Place ${place.id} (weekday) has 3 intervals. Returning group 1.`);
        return [1]; 
      }
      if (dayStats.length === 5) { 
         this.logger.log(`Place ${place.id} (weekday) has 5 intervals. Returning group 2.`);
        return [2]; 
      }
       this.logger.warn(`Place ${place.id} (weekday) has unexpected interval count: ${dayStats.length}. Returning empty array.`);
      return []; 
    } 
    else { 
        if (dayStats.length === 3) { 
            this.logger.log(`Place ${place.id} (weekend) has 3 intervals. Returning group 3.`);
            return [3]; 
        }
         this.logger.warn(`Place ${place.id} (weekend) has unexpected interval count: ${dayStats.length}. Returning empty array.`);
        return []; 
    }
  }
}
