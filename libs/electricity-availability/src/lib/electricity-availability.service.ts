import { Place } from '@electrobot/domain';
import { PlaceRepository } from '@electrobot/place-repo';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule'; 
import {
  addHours, addMinutes, addMonths, differenceInMinutes, eachDayOfInterval,
  endOfDay, endOfMonth, format, formatDistance, getDay, getMonth,
  startOfDay, startOfMonth, subMinutes,
} from 'date-fns';
import { convertToTimeZone } from 'date-fns-timezone';
import { uk } from 'date-fns/locale';
import { firstValueFrom, Subject } from 'rxjs'; // Прибираємо timer, zip
import { HistoryItem } from './history-item.type';
import { ElectricityRepository } from './electricity.repository'; 
import * as net from 'net'; 

@Injectable()
export class ElectricityAvailabilityService {
  private readonly logger = new Logger(ElectricityAvailabilityService.name);

  // --- ВИДАЛЕНО 'place$' ТА 'forceCheck$' ---

  // --- 'availabilityChange$' БІЛЬШЕ НЕ ПОТРІБЕН, ОСКІЛЬКИ CRON ВИКЛИКАЄ ВСЕ НАПРЯМУ ---
  // public readonly availabilityChange$ = ...

  // --- ЗМІНЕНО: Ми більше не підписуємось на availabilityChange$ ---
  constructor(
    private readonly electricityRepository: ElectricityRepository,
    private readonly placeRepository: PlaceRepository,
    private readonly httpService: HttpService 
  ) {
    // this.availabilityChange$.subscribe(); // <-- ВИДАЛЕНО
    this.logger.log('ElectricityAvailabilityService initialized.');
  }

  // --- МЕТОД 'check' (ЗАЛИШАЄТЬСЯ БЕЗ ЗМІН, ВИКОРИСТОВУЄ API) ---
  private async check(place: Place): Promise<{
    readonly place: Place;
    readonly isAvailable: boolean;
  }> {
    const host = place.host;
    const port = 80;
    const url = `https://check-host.net/check-ping?host=${host}&node=de.fra&json=true`; // Використовуємо PING API

    this.logger.verbose(`Starting PING check for ${host} via API (${url})...`);
    let isAvailable = false; 

    try {
        const response = await firstValueFrom(
            this.httpService.get(url, { 
                timeout: 10000, 
                headers: { 'User-Agent': 'Koyeb Electro Bot Check' } 
            })
        );

        if (response.data && response.data.ok === 1) {
            const nodes = response.data.nodes;
            const nodeName = Object.keys(nodes)[0]; 
            const nodeResult = nodes[nodeName];

            if (nodeResult && Array.isArray(nodeResult) && nodeResult[0] && nodeResult[0][0] === 'OK') {
                isAvailable = true;
                this.logger.debug(`PING check successful for ${host}. API response: ${JSON.stringify(nodeResult[0])}`);
            } else {
                isAvailable = false;
                this.logger.warn(`PING check failed (API reported failure) for ${host}. Response: ${JSON.stringify(nodeResult)}`);
            }
        } else {
             isAvailable = false;
             this.logger.error(`PING check via API failed (API returned error). Status: ${response.status}. Data: ${JSON.stringify(response.data)}`);
        }
    } catch (error: any) {
        isAvailable = false;
        if (error.code !== 'ECONNABORTED' && (!error.response || error.response.status !== 504)) {
             this.logger.error(`PING check via API failed (HTTP Error) for ${host}. Error: ${error.message}`);
        } else {
             this.logger.warn(`PING check via API timed out for ${host}. Assuming unavailable.`);
        }
    }

    return { place, isAvailable };
  }
  // --- КІНЕЦЬ МЕТОДУ CHECK ---

  // --- ПОВНІСТЮ ПЕРЕПИСАНИЙ МЕТОД CRON ---
  @Cron(CronExpression.EVERY_MINUTE, { // Змінено на EVERY_MINUTE для швидкої перевірки
    name: 'check-electricity-availability',
  })
  public async checkAndSaveElectricityAvailabilityStateOfAllPlaces(): Promise<void> {
    this.logger.verbose('Cron job "check-electricity-availability" started.');
    try {
      const places = await this.placeRepository.getAllPlaces();
      this.logger.debug(`Cron: Loaded ${places.length} places to check.`);

      // Використовуємо Promise.all, щоб перевірити всі місця паралельно
      await Promise.all(places.map(async (place) => {
        if (place && !place.isDisabled) {
          this.logger.debug(`Cron: Checking place ${place.name}...`);
          // НАПРЯМУ викликаємо 'check'
          const { isAvailable } = await this.check(place);
          // НАПРЯМУ викликаємо 'handleAvailabilityChange'
          await this.handleAvailabilityChange({ place, isAvailable });
        } else if (place) {
          this.logger.debug(`Cron: Skipping disabled place ${place.name}.`);
        }
      }));

      this.logger.verbose('Cron job "check-electricity-availability" finished.');
    } catch (error) {
       this.logger.error(`Cron: Failed to load places or check availability: ${error}`, error instanceof Error ? error.stack : undefined);
    }
  }
  // --- КІНЕЦЬ ПЕРЕПИСАНОГО МЕТОДУ CRON ---

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
        if (!latest || latest.is_available !== isAvailable) { // Виправлено
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
    readonly to?: Date;
  }): Promise<
    ReadonlyArray<{
      readonly time: Date;
      readonly is_available: boolean; // Виправлено
    }>
  > {
    this.logger.debug(`Getting latest availability for place ${params.placeId} (limit ${params.limit})`);
    try {
        return await this.electricityRepository.getLatest({
            placeId: params.placeId,
            limit: params.limit,
            to: params.to
        });
    } catch (error) {
        this.logger.error(`Error in getLatestPlaceAvailability for ${params.placeId}: ${error}`, error instanceof Error ? error.stack : undefined);
        return []; 
    }
  }

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
          lastStateBeforeToday: lastStateBeforeToday?.is_available, // Виправлено
          lastStateBeforeYesterday: lastStateBeforeYesterday?.is_available, // Виправлено
        };
    } catch (error) {
         this.logger.error(`Error in getTodayAndYesterdayStats for ${place.id}: ${error}`, error instanceof Error ? error.stack : undefined);
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
        if (!history || !history.length) {
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
        const { totalMinutesAvailable, totalMinutesUnavailable } =
          await this.getMonthStats(params); // Виклик виправлено

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

    if (!dayStats) { 
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
