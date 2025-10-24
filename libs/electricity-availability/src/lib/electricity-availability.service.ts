import { Place } from '@electrobot/domain';
import { PlaceRepository } from '@electrobot/place-repo';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, OnModuleInit, forwardRef, Inject  } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationBotService } from '@electrobot/bot';
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
} from 'date-fns';
import { convertToTimeZone } from 'date-fns-timezone';
import { uk } from 'date-fns/locale';
import { firstValueFrom, Subject, timer, zip } from 'rxjs';
import {
  distinctUntilChanged,
  filter,
  map,
  switchMap,
} from 'rxjs/operators';
import { HistoryItem } from './history-item.type';
import { ElectricityRepository } from './electricity.repository'; 
import * as net from 'net'; 

const CHECK_INTERVAL_IN_MINUTES = 2; // Частота перевірки Cron
const API_KEY = 'demo'; // Використовуємо демонстраційний ключ

@Injectable()
export class ElectricityAvailabilityService {
  private readonly logger = new Logger(
    ElectricityAvailabilityService.name
  );
  // --- ДОДАНО ЗАМОК (LOCK) ---
  private static isCronRunning = false; 
  // ---------------------------
  
  private readonly place$ = new Subject<Place>();
  private readonly forceCheck$ = new Subject<Place>();

  // public readonly availabilityChange$ = zip(
  //   this.place$,
  //   timer(0, CHECK_INTERVAL_IN_MINUTES * 60 * 1000) // Повертаємо числовий інтервал
  // ).pipe(
  //   map(([place]) => place),
  //   filter((place) => place && !place.isDisabled),
  //   switchMap((place) => this.checkWithRetries(place)), // Викликаємо checkWithRetries
  //   distinctUntilChanged((prev, curr) => prev.isAvailable === curr.isAvailable),
  //   map(({ place, isAvailable }) => {
  //     this.handleAvailabilityChange({ place, isAvailable });
  //     return { placeId: place.id };
  //   })
  // );

constructor(
  private readonly electricityRepository: ElectricityRepository,
  private readonly placeRepository: PlaceRepository,
  private readonly httpService: HttpService,
  @Inject(forwardRef(() => NotificationBotService)) // <-- ВИПРАВЛЕНО
  private readonly notificationBotService: NotificationBotService
) {
    // this.availabilityChange$.subscribe(); // <-- ВИМКНЕНО
    this.logger.log("ElectricityAvailabilityService initialized (availabilityChange$ stream disabled, using Cron only).");
  }

  // --- НОВИЙ ДОПОМІЖНИЙ МЕТОД ---
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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


  // --- ОНОВЛЕНИЙ МЕТОД CHECK (використовує ViewDNS API) ---
  private async check(place: Place): Promise<{
    readonly place: Place;
    readonly isAvailable: boolean;
  }> {
    const host = place.host;
    const url = `https://api.viewdns.info/ping/v2/?host=${host}&apikey=${API_KEY}&output=json`;

    this.logger.verbose(`Starting PING check for ${host} via ViewDNS API...`);
    let isAvailable = false; 

    try {
        const response = await firstValueFrom(
            this.httpService.get(url, { 
                timeout: 15000, // Збільшуємо тайм-аут до 15 секунд
                headers: { 'User-Agent': 'Koyeb Electro Bot Check' } 
            })
        );
        
        if (response.data && response.data.response && response.data.response.detail) {
            // Шукаємо регіон "Europe"
            const europeRegion = response.data.response.detail.find(
                (region: any) => region.region === 'Europe'
            );

            if (europeRegion && europeRegion.locations && europeRegion.locations.length > 0) {
                // Перевіряємо, чи ХОЧА Б ОДНА європейська локація має 0% втрат
                const isAnyEuropeLocationOK = europeRegion.locations.some(
                    (loc: any) => loc.packet_loss === '0%'
                );
                
                if (isAnyEuropeLocationOK) {
                    isAvailable = true;
                    this.logger.debug(`PING check successful for ${host} from Europe.`);
                } else {
                    isAvailable = false;
                    this.logger.warn(`PING check failed (Europe locations reported packet loss) for ${host}.`);
                }
            } else {
                isAvailable = false;
                this.logger.warn(`PING check failed (No 'Europe' region found in API response) for ${host}.`);
            }
        } else {
             isAvailable = false;
             this.logger.error(`PING check via API failed (Invalid JSON response). Status: ${response.status}. Data: ${JSON.stringify(response.data)}`);
        }
    } catch (error: any) {
        isAvailable = false;
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.response?.status === 504) {
             this.logger.warn(`PING check via API timed out for ${host}. Assuming unavailable.`);
        } else {
             this.logger.error(`PING check via API failed (HTTP Error) for ${host}. Error: ${error.message}`);
        }
    }

    return { place, isAvailable };
  }
  // --- КІНЕЦЬ МЕТОДУ CHECK ---

@Cron('*/3 * * * *', { // <-- ЗМІНЕНО НА КОЖНІ 3 ХВИЛИНИ
    name: 'check-electricity-availability',
  })
  public async checkAndSaveElectricityAvailabilityStateOfAllPlaces(): Promise<void> {
    // --- ПЕРЕВІРКА ЗАМКА ---
    if (ElectricityAvailabilityService.isCronRunning) {
        this.logger.warn('Cron job "check-electricity-availability" is already running. Skipping this run.');
        return;
    }
    ElectricityAvailabilityService.isCronRunning = true;
    this.logger.log('Cron job "check-electricity-availability" (checkAndSave...) started.');
    // ----------------------
    try {
      const places = await this.placeRepository.getAllPlaces();
      this.logger.debug(`Cron: Loaded ${places.length} places to check.`);
      
      await Promise.all(places.map(async (place) => {
        if (place && !place.isDisabled) { 
            this.logger.debug(`Cron: Checking place ${place.name}...`);
            const { isAvailable } = await this.checkWithRetries(place); // Викликаємо з повторними спробами
            await this.handleAvailabilityChange({ place, isAvailable });
        } else if (place) {
            this.logger.debug(`Cron: Skipping disabled place ${place.name}.`);
        }
      }));

this.logger.verbose('Cron job "check-electricity-availability" finished.');
  } catch (error) {
     this.logger.error(`Cron: Failed to load places or check availability: ${error}`, error instanceof Error ? error.stack : undefined);
  } finally {
     // --- ВІДПУСКАЄМО ЗАМОК ---
     ElectricityAvailabilityService.isCronRunning = false;
     this.logger.log('Cron job "check-electricity-availability" lock released.');
     // ------------------------
  }
}

private async handleAvailabilityChange(params: {
  readonly place: Place;
  readonly isAvailable: boolean;
}): Promise<void> {
  const { place, isAvailable } = params;
  if (!place) {
      this.logger.error('handleAvailabilityChange called with undefined place.');
      return;
  }
  this.logger.log(`Handling availability change for ${place.name}: ${isAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}`);
  try {
      const [latest] = await this.electricityRepository.getLatest({ placeId: place.id, limit: 1 });
      if (!latest || latest.is_available !== isAvailable) { 
        this.logger.log(`State changed for ${place.name}. Saving new state: ${isAvailable}`);
        await this.electricityRepository.save({ placeId: place.id, isAvailable });

        // --- ДОДАНО ВИКЛИК СПОВІЩЕННЯ ---
        this.logger.log(`Triggering notification for place ${place.id}`);
        await this.notificationBotService.notifyAllPlaceSubscribersAboutElectricityAvailabilityChange({ placeId: place.id });
        // ---------------------------------

      } else {
        this.logger.debug(`State for ${place.name} has not changed. Skipping save.`);
      }
  } catch (error) {
       this.logger.error(`Error saving availability change for ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
  }
}

  
  public async getLatestPlaceAvailability(params: {
    readonly placeId: string;
    readonly limit: number;
    readonly to?: Date; // Додаємо необов'язковий параметр 'to'
  }): Promise<
    ReadonlyArray<{
      readonly time: Date;
      readonly is_available: boolean; // Виправлено
    }>
  > {
    this.logger.debug(`Getting latest availability for place ${params.placeId} (limit ${params.limit})`);
    try {
        // Переконуємось, що передаємо 'to' якщо він є
        return await this.electricityRepository.getLatest({
            placeId: params.placeId,
            limit: params.limit,
            to: params.to
        });
    } catch (error) {
        this.logger.error(`Error in getLatestPlaceAvailability for ${params.placeId}: ${error}`, error instanceof Error ? error.stack : undefined);
        return []; // Повертаємо порожній масив у разі помилки
    }
  }

  // --- ВІДНОВЛЮЄМО РЕАЛІЗАЦІЮ ---
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
    this.logger.debug(`Getting today/yesterday stats for place ${place.id}`);
    try {
        const now = convertToTimeZone(new Date(), { timeZone: place.timezone });
        const todayStart = startOfDay(now);
        const yesterdayStart = startOfDay(addHours(todayStart, -2)); // Беремо початок попереднього дня
        const yesterdayEnd = endOfDay(yesterdayStart);

        const [todayHistory, yesterdayHistory] = await Promise.all([
          this.electricityRepository.getHistory({
            placeId: place.id,
            from: todayStart,
            to: now,
          }),
          this.electricityRepository.getHistory({
            placeId: place.id,
            from: yesterdayStart,
            to: yesterdayEnd,
          }),
        ]);

        const [lastStateBeforeToday] =
          await this.electricityRepository.getLatest({
            placeId: place.id,
            limit: 1,
            to: subMinutes(todayStart, 1),
          });

        const [lastStateBeforeYesterday] =
          await this.electricityRepository.getLatest({
            placeId: place.id,
            limit: 1,
            to: subMinutes(yesterdayStart, 1),
          });

        return {
          history: {
            today: todayHistory,
            yesterday: yesterdayHistory,
          },
          // Виправляємо помилку: база повертає is_available
          lastStateBeforeToday: lastStateBeforeToday?.is_available, 
          lastStateBeforeYesterday: lastStateBeforeYesterday?.is_available,
        };
    } catch (error) {
         this.logger.error(`Error in getTodayAndYesterdayStats for ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
         return { history: { today: [], yesterday: [] } };
    }
  }

  // --- ВІДНОВЛЮЄМО РЕАЛІЗАЦІЮ ---
  public async getMonthStats(params: {
    readonly place: Place;
    readonly dateFromTargetMonth: Date;
  }): Promise<{
    readonly totalMinutesAvailable: number;
    readonly totalMinutesUnavailable: number;
  }> {
    const { place, dateFromTargetMonth } = params;
    if (!place || !dateFromTargetMonth) {
        this.logger.error('getMonthStats called with undefined params.');
        return { totalMinutesAvailable: 0, totalMinutesUnavailable: 0 };
    }
    this.logger.debug(`Getting month stats for place ${place.id}, month: ${format(dateFromTargetMonth, 'yyyy-MM')}`);
    try {
        const start = convertToTimeZone(startOfMonth(dateFromTargetMonth), {
          timeZone: place.timezone,
        });
        const end = convertToTimeZone(endOfMonth(dateFromTargetMonth), {
          timeZone: place.timezone,
        });
        const history = await this.electricityRepository.getHistory({
          placeId: place.id,
          from: start,
          to: end,
        });
        if (!history || !history.length) { // Додано перевірку
          this.logger.warn(`No history data found for month stats, place ${place.id}`);
          return { totalMinutesAvailable: 0, totalMinutesUnavailable: 0 };
        }
        let totalMinutesAvailable = 0;
        let totalMinutesUnavailable = 0;
        history.forEach(({ start, end, isEnabled }) => {
           if (!start || !end) { this.logger.error(`Invalid history item in getMonthStats: ${JSON.stringify({start, end, isEnabled})}`); return; }
           let durationInMinutes = 0;
           try {
              durationInMinutes = Math.abs(differenceInMinutes(new Date(end), new Date(start)));
           } catch (diffError) { this.logger.error(`Error calculating diff in getMonthStats: ${diffError}`); return; }
          if (isEnabled) {
            totalMinutesAvailable += durationInMinutes;
          } else {
            totalMinutesUnavailable += durationInMinutes;
          }
        });
         this.logger.debug(`Calculated month stats for place ${place.id}: Available=${totalMinutesAvailable}, Unavailable=${totalMinutesUnavailable}`);
        return { totalMinutesAvailable, totalMinutesUnavailable };
    } catch (error) {
        this.logger.error(`Error in getMonthStats for ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
        return { totalMinutesAvailable: 0, totalMinutesUnavailable: 0 };
    }
  }
  
  // --- ВІДНОВЛЮЄМО РЕАЛІЗАЦІЮ ---
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

  // --- ВІДНОВЛЮЄМО РЕАЛІЗАЦІЮ ---
  public async getDayStats(params: {
    readonly place: Place;
    readonly date: Date;
  }): Promise<
    ReadonlyArray<{
      readonly start: Date;
      readonly end: Date;
      readonly isEnabled: boolean;
    }>
  > {
    const { place, date } = params;
    if (!place || !date) {
        this.logger.error('getDayStats called with undefined params.');
        return [];
    }
    this.logger.debug(`Getting day stats for place ${place.id}, date: ${format(date, 'yyyy-MM-dd')}`);
    try {
        const start = convertToTimeZone(startOfDay(date), {
          timeZone: place.timezone,
        });
        const end = convertToTimeZone(endOfDay(date), {
          timeZone: place.timezone,
        });

        return await this.electricityRepository.getHistory({
          placeId: place.id,
          from: start,
          to: end,
        });
    } catch (error) {
         this.logger.error(`Error in getDayStats for ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
         return [];
    }
  }

  // --- ВІДНОВЛЮЄМО РЕАЛІЗАЦІЮ ---
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

  // --- ВІДНОВЛЮЄМО РЕАЛІЗАЦІЮ ---
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
