import { Place } from '@electrobot/domain';
import { PlaceRepository } from '@electrobot/place-repo';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule'; // Замінюємо CronExpression на Cron
import {
  addHours,
  addMonths,
  differenceInMinutes,
  eachDayOfInterval,
  endOfDay,
  endOfMonth,
  format,
  getDay,
  startOfDay,
  startOfMonth,
  subMinutes,
} from 'date-fns';
import { convertToTimeZone } from 'date-fns-timezone';
import { uk } from 'date-fns/locale';
import { firstValueFrom, Subject, timer, zip } from 'rxjs'; // Імпортуємо Subject, timer, zip
import {
  distinctUntilChanged,
  filter,
  map,
  switchMap,
} from 'rxjs/operators';
import { HistoryItem } from './history-item.type';
import { ElectricityRepository } from './electricity.repository';
// ping, ping-promise, net - ВИДАЛЕНО. Будемо використовувати HttpService

// const PING_TIMEOUT_IN_SECONDS = 10; // Більше не потрібно
const CHECK_INTERVAL_IN_MINUTES = 2; // Частота перевірки Cron
const MAX_UNAVAILABILITY_TRESHOLD_IN_MINUTES = 20;

@Injectable()
export class ElectricityAvailabilityService {
  private readonly logger = new Logger(
    ElectricityAvailabilityService.name
  );
  // Змінюємо тип place$, додаємо forceCheck$
  private readonly place$ = new Subject<Place>();
  private readonly forceCheck$ = new Subject<Place>();

  public readonly availabilityChange$ = zip(
    this.place$,
    timer(0, CHECK_INTERVAL_IN_MINUTES * 60 * 1000)
  ).pipe(
    map(([place]) => place),
    filter((place) => !place.isDisabled),
    switchMap((place) => this.check(place)),
    distinctUntilChanged((prev, curr) => prev.isAvailable === curr.isAvailable),
    map(({ place, isAvailable }) => {
      this.handleAvailabilityChange({ place, isAvailable });
      return { placeId: place.id };
    })
  );

  constructor(
    private readonly electricityRepository: ElectricityRepository,
    private readonly placeRepository: PlaceRepository,
    private readonly httpService: HttpService // <-- Додаємо HttpService
  ) {
    this.availabilityChange$.subscribe();
  }

  // --- ЦЕЙ МЕТОД ПОВНІСТЮ ПЕРЕПИСАНО ---
  private async check(place: Place): Promise<{
    readonly place: Place;
    readonly isAvailable: boolean;
  }> {
    // Ми будемо використовувати API-сервіс, який перевіряє TCP-порт 80
    // Оскільки ми знаємо, що ping (ICMP) заблокований, а TCP/80 - відкритий

    const host = place.host;
    const port = 80; // Використовуємо порт 80, який у вас відкритий
    const url = `https://port.ping.pe/${host}/${port}`; // Простий API

    this.logger.verbose(`Starting TCP check for ${host}:${port} via API (${url})...`);

    let isAvailable = false; // За замовчуванням - світла немає

    try {
        // Робимо HTTP GET запит до API
        const response = await firstValueFrom(
            this.httpService.get(url, {
                timeout: 10000, // Тайм-аут 10 секунд
                headers: { 'User-Agent': 'curl/7.64.1' } // Деякі API вимагають User-Agent
            })
        );

        // `port.ping.pe` повертає 200 OK і тіло "OK..." якщо порт відкритий
        // і 200 OK з тілом "Error..." або інший код (напр. 500) якщо закритий
        const responseText = String(response.data);

        if (response.status === 200 && responseText.includes('OK')) {
            isAvailable = true;
            this.logger.debug(`TCP check successful for ${host}:${port}. API response: ${responseText.substring(0, 20)}`);
        } else {
            isAvailable = false;
            this.logger.warn(`TCP check failed (API reported failure) for ${host}:${port}. Status: ${response.status}. Response: ${responseText.substring(0, 50)}`);
        }
    } catch (error: any) {
        // Якщо запит до API "впав" (тайм-аут, 500, ECONNREFUSED)
        isAvailable = false;
        this.logger.error(`TCP check via API failed for ${host}:${port}. Error: ${error.message}`);
    }

    return { place, isAvailable };
  }
  // --- КІНЕЦЬ ПЕРЕПИСАНОГО МЕТОДУ ---

  // Викликається кожні 2 хвилини
  @Cron(CronExpression.EVERY_2_MINUTES, {
    name: 'check-electricity-availability',
  })
  private async handleCron(): Promise<void> {
    this.logger.verbose('Cron job "check-electricity-availability" started.');
    try {
      const places = await this.placeRepository.getAllPlaces();
      this.logger.debug(`Cron: Loaded ${places.length} places to check.`);
      places.forEach((place) => {
        this.logger.debug(`Cron: Pushing place ${place.name} to check queue.`);
        this.place$.next(place);
      });
    } catch (error) {
       this.logger.error(`Cron: Failed to load places: ${error}`, error instanceof Error ? error.stack : undefined);
    }
  }

  private async handleAvailabilityChange(params: {
    readonly place: Place;
    readonly isAvailable: boolean;
  }): Promise<void> {
    const { place, isAvailable } = params;
    this.logger.log(`Handling availability change for ${place.name}: ${isAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}`);
    try {
        const [latest] = await this.electricityRepository.getLatest({ placeId: place.id, limit: 1 });
        if (!latest || latest.isAvailable !== isAvailable) {
          this.logger.log(`State changed for ${place.name}. Saving new state: ${isAvailable}`);
          await this.electricityRepository.save({ placeId: place.id, isAvailable });
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
  }): Promise<
    ReadonlyArray<{
      readonly time: Date;
      readonly isAvailable: boolean;
    }>
  > {
    this.logger.debug(`Getting latest availability for place ${params.placeId} (limit ${params.limit})`);
    try {
        return await this.electricityRepository.getLatest(params);
    } catch (error) {
        this.logger.error(`Error in getLatestPlaceAvailability for ${params.placeId}: ${error}`, error instanceof Error ? error.stack : undefined);
        return []; // Повертаємо порожній масив у разі помилки
    }
  }

  // TODO: refactor (make cleaner)
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
    this.logger.debug(`Getting today/yesterday stats for place ${place.id}`);
    try {
        const now = convertToTimeZone(new Date(), { timeZone: place.timezone });
        const todayStart = startOfDay(now);
        const yesterdayStart = startOfDay(addHours(todayStart, -2));
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
          lastStateBeforeToday: lastStateBeforeToday?.isAvailable,
          lastStateBeforeYesterday: lastStateBeforeYesterday?.isAvailable,
        };
    } catch (error) {
         this.logger.error(`Error in getTodayAndYesterdayStats for ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
         // Повертаємо порожню структуру у разі помилки
         return { history: { today: [], yesterday: [] } };
    }
  }
  public async getMonthStats(params: {
        readonly place: Place;
        readonly dateFromTargetMonth: Date;
      }): Promise<{
        readonly totalMinutesAvailable: number;
        readonly totalMinutesUnavailable: number;
      }> {
        const { place, dateFromTargetMonth } = params;
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

            if (!history.length) {
              this.logger.warn(`No history data found for month stats, place ${place.id}`);
              return { totalMinutesAvailable: 0, totalMinutesUnavailable: 0 };
            }

            let totalMinutesAvailable = 0;
            let totalMinutesUnavailable = 0;

            history.forEach(({ start, end, isEnabled }) => {
               // Додаємо перевірку на start/end
               if (!start || !end) {
                  this.logger.error(`Invalid history item found during month stats: ${JSON.stringify({start, end, isEnabled})}`);
                  return;
               }
               let durationInMinutes = 0;
               try {
                  durationInMinutes = Math.abs(differenceInMinutes(new Date(end), new Date(start)));
               } catch (diffError) {
                  this.logger.error(`Error calculating differenceInMinutes for month stats: ${diffError}`);
                  return; // Пропускаємо
               }

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
            return { totalMinutesAvailable: 0, totalMinutesUnavailable: 0 }; // Повертаємо 0 у разі помилки
        }
      }

      public async getMonthStatsMessage(params: {
        readonly place: Place;
        readonly dateFromTargetMonth: Date;
      }): Promise<string> {
        this.logger.debug(`Getting month stats message for place ${params.place.id}`);
        try {
            const { totalMinutesAvailable, totalMinutesUnavailable } =
              await this.getMonthStats(params);

            const totalMinutes = totalMinutesAvailable + totalMinutesUnavailable;
            if (totalMinutes === 0) {
              this.logger.warn(`Total minutes for month stats message is zero for place ${params.place.id}`);
              return ''; // Повертаємо порожній рядок, якщо немає даних
            }

            const percentAvailable = Math.round( // Використовуємо Math.round
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
             return ''; // Повертаємо порожній рядок у разі помилки
        }
      }

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
        this.logger.debug(`Getting day off groups for place ${place.id}, date: ${format(date, 'yyyy-MM-dd')}`);
        const dayOfWeek = getDay(date); // 0 - Неділя, 1 - Понеділок ... 6 - Субота
        const dayStats = await this.getDayStats({ place, date });
        
        // Перевіряємо, чи день повністю без світла
        if (dayStats.length === 1 && !dayStats[0].isEnabled) {
            // Якщо за весь день був лише один запис "немає світла"
            this.logger.log(`Place ${place.id} was OFF all day on ${format(date, 'yyyy-MM-dd')}. Returning group 0.`);
            return [0]; // Група 0 (повністю без світла)
        }
        
        // Перевіряємо, чи день повністю зі світлом
        if (dayStats.length === 1 && dayStats[0].isEnabled) {
             // Якщо за весь день був лише один запис "є світло"
            this.logger.log(`Place ${place.id} was ON all day on ${format(date, 'yyyy-MM-dd')}. Returning group 4.`);
            return [4]; // Група 4 (повністю зі світлом)
        }

        // Логіка для звичайних днів (пн-пт)
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
          if (dayStats.length === 3) { // 3 інтервали (вимк-увімк-вимк)
            this.logger.log(`Place ${place.id} (weekday) has 3 intervals. Returning group 1.`);
            return [1]; // Група 1
          }
          if (dayStats.length === 5) { // 5 інтервалів
             this.logger.log(`Place ${place.id} (weekday) has 5 intervals. Returning group 2.`);
            return [2]; // Група 2
          }
          // Інші випадки на буднях
           this.logger.warn(`Place ${place.id} (weekday) has unexpected interval count: ${dayStats.length}. Returning empty array.`);
          return []; // Невідома група
        } 
        // Логіка для вихідних (сб, нд)
        else { 
            if (dayStats.length === 3) { // 3 інтервали (вимк-увімк-вимк)
                this.logger.log(`Place ${place.id} (weekend) has 3 intervals. Returning group 3.`);
                return [3]; // Група 3
            }
             // Інші випадки на вихідних
             this.logger.warn(`Place ${place.id} (weekend) has unexpected interval count: ${dayStats.length}. Returning empty array.`);
            return []; // Невідома група
        }
      }
    }
