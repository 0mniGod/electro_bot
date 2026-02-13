import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

// Інтерфейс для даних з outage-data-ua
interface OutageDataResponse {
    regionId: string;
    lastUpdated: string;
    fact: {
        data: {
            [timestamp: string]: {
                [gpvGroup: string]: {
                    [hour: string]: string; // "yes", "no", "first", "second"
                }
            }
        };
        today: number; // Timestamp для актуальних даних
        updateFact?: string;
    };
    preset?: any;
    lastUpdateStatus: {
        status: string;
        ok: boolean;
        code: number;
        message: string | null;
        at: string;
    };
}

interface ParsedSchedule {
    timestamp: string;
    schedule: {
        [hour: string]: string;
    };
    lastUpdated: string;
    updateFact?: string;
}

@Injectable()
export class OutageDataService {
    private readonly logger = new Logger(OutageDataService.name);
    private readonly baseUrl = 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main';
    private cachedData: OutageDataResponse | null = null;
    private lastFetchTime: Date | null = null;

    constructor(private readonly httpService: HttpService) { }

    /**
     * Завантажує JSON файл з графіком для Києва
     */
    public async fetchKyivSchedule(): Promise<OutageDataResponse | null> {
        const url = `${this.baseUrl}/data/kyiv.json`;

        try {
            this.logger.log(`[OutageData] Fetching schedule from ${url}...`);

            const response = await firstValueFrom(
                this.httpService.get<OutageDataResponse>(url, {
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json'
                    }
                })
            );

            if (response.data) {
                this.cachedData = response.data;
                this.lastFetchTime = new Date();
                this.logger.log(`[OutageData] Successfully fetched schedule. Last updated: ${response.data.lastUpdated}`);
                return response.data;
            } else {
                this.logger.warn('[OutageData] Empty response from GitHub');
                return null;
            }
        } catch (error: any) {
            this.logger.error(`[OutageData] Failed to fetch schedule: ${error.message}`, error.stack);
            return null;
        }
    }

    /**
     * Парсить дані для конкретної GPV групи
     * @param groupKey - Ключ групи у форматі "GPV28.1"
     */
    public parseGroupSchedule(groupKey: string): ParsedSchedule | null {
        if (!this.cachedData || !this.cachedData.fact || !this.cachedData.fact.data) {
            this.logger.warn('[OutageData] No cached data available for parsing');
            return null;
        }

        try {
            // Використовуємо fact.today для отримання актуальних даних
            const todayTimestamp = this.cachedData.fact.today;
            if (!todayTimestamp) {
                this.logger.warn('[OutageData] fact.today not found in cached data');
                return null;
            }

            const timestampData = this.cachedData.fact.data[todayTimestamp];
            if (!timestampData) {
                this.logger.warn(`[OutageData] No data found for timestamp ${todayTimestamp}`);
                return null;
            }

            this.logger.log(`[OutageData] Using timestamp from fact.today: ${todayTimestamp}`);

            // Формуємо ключ групи у правильному форматі
            const formattedGroupKey = groupKey.startsWith('GPV') ? groupKey : `GPV${groupKey}`;

            this.logger.log(`[OutageData] Looking for key: "${formattedGroupKey}"`);
            this.logger.log(`[OutageData] Available keys in timestamp data: ${Object.keys(timestampData).join(', ')}`);

            if (!timestampData[formattedGroupKey]) {
                this.logger.warn(`[OutageData] Group ${formattedGroupKey} not found in data`);
                return null;
            }

            const schedule = this.normalizeSchedule(timestampData[formattedGroupKey]);

            this.logger.log(`[OutageData] Parsed schedule for ${formattedGroupKey}, timestamp: ${todayTimestamp}`);
            this.logger.log(`[OutageData] Schedule keys: ${Object.keys(schedule).length} hours`);
            this.logger.log(`[OutageData] First 3 hours: ${JSON.stringify(Object.entries(schedule).slice(0, 3))}`);
            this.logger.log(`[OutageData] FULL SCHEDULE: ${JSON.stringify(schedule)}`);

            return {
                timestamp: todayTimestamp.toString(),
                schedule: schedule,
                lastUpdated: this.cachedData.lastUpdated,
                updateFact: this.cachedData.fact.updateFact
            };
        } catch (error: any) {
            this.logger.error(`[OutageData] Failed to parse group schedule: ${error.message}`, error.stack);
            return null;
        }
    }

    /**
     * Генерує URL зображення для конкретної GPV групи
     * @param groupKey - Ключ групи у форматі "28.1"
     * @returns URL зображення emergency графіку
     */
    public getImageUrl(groupKey: string): string {
        // Конвертуємо "28.1" в "gpv-28-1-emergency.png"
        const cleanKey = groupKey.replace('GPV', '').replace('.', '-');

        // Додаємо timestamp як query параметр для уникнення кешування в Telegram
        // Використовуємо час останнього завантаження даних для cache-busting
        const timestamp = this.lastFetchTime
            ? Math.floor(this.lastFetchTime.getTime() / 1000)
            : Math.floor(Date.now() / 1000);

        return `${this.baseUrl}/images/kyiv/gpv-${cleanKey}-emergency.png?t=${timestamp}`;
    }

    /**
     * Порівнює два графіки та визначає, чи є зміни
     * @param oldSchedule - Старий графік
     * @param newSchedule - Новий графік
     * @returns true якщо графіки відрізняються
     */
    public hasScheduleChanged(oldSchedule: ParsedSchedule | null, newSchedule: ParsedSchedule | null): boolean {
        if (!oldSchedule && !newSchedule) return false;
        if (!oldSchedule || !newSchedule) return true;

        // Порівнюємо timestamp - якщо різні, то дані оновилися
        if (oldSchedule.timestamp !== newSchedule.timestamp) {
            this.logger.log(`[OutageData] Timestamp changed: ${oldSchedule.timestamp} -> ${newSchedule.timestamp}`);
            return true;
        }

        // Порівнюємо графіки погодинно
        const oldHours = Object.keys(oldSchedule.schedule).sort();
        const newHours = Object.keys(newSchedule.schedule).sort();

        if (oldHours.length !== newHours.length) {
            this.logger.log(`[OutageData] Schedule length changed: ${oldHours.length} -> ${newHours.length}`);
            return true;
        }

        for (const hour of oldHours) {
            if (oldSchedule.schedule[hour] !== newSchedule.schedule[hour]) {
                this.logger.log(`[OutageData] Schedule changed at hour ${hour}: ${oldSchedule.schedule[hour]} -> ${newSchedule.schedule[hour]}`);
                return true;
            }
        }

        return false;
    }

    /**
     * Отримує кешовані дані (якщо є)
     */
    public getCachedData(): OutageDataResponse | null {
        return this.cachedData;
    }

    /**
     * Форматує графік у текстовий вигляд для відображення
     * @param schedule - Графік для форматування
     * @returns Текстове представлення графіку
     */
    public formatScheduleText(schedule: ParsedSchedule): string {
        const lines: string[] = [];

        // Лічильники для статистики
        let hoursWithLight = 0;
        let hoursWithoutLight = 0;

        // Сортуємо години
        const hours = Object.keys(schedule.schedule).sort((a, b) => parseInt(a) - parseInt(b));

        for (const hour of hours) {
            const status = schedule.schedule[hour];
            let emoji = '❔';
            let text = 'невідомо';

            if (status === 'yes') {
                emoji = '💡';
                text = 'є світло';
                hoursWithLight++;
            } else if (status === 'no') {
                emoji = '🌚';
                text = 'немає світла';
                hoursWithoutLight++;
            } else if (status === 'first') {
                emoji = '🕐';
                text = 'немає світла (1-а половина)';
                hoursWithoutLight += 0.5;
                hoursWithLight += 0.5;
            } else if (status === 'second') {
                emoji = '🕑';
                text = 'немає світла (2-а половина)';
                hoursWithoutLight += 0.5;
                hoursWithLight += 0.5;
            }

            lines.push(`${emoji} ${hour}:00 - ${text}`);
        }

        // Додаємо статистику
        lines.push('');
        lines.push(`📊 **Статистика:**`);
        lines.push(`💡 Зі світлом: ${hoursWithLight} год`);
        lines.push(`🌚 Без світла: ${hoursWithoutLight} год`);

        return lines.join('\n');
    }

    /**
     * Перевіряє чи є графік placeholder (всі години "yes")
     */
    public isPlaceholderSchedule(schedule: { [hour: string]: string }): boolean {
        const hours = Object.keys(schedule);
        if (hours.length !== 24) return false;

        return hours.every(hour => schedule[hour] === 'yes');
    }

    /**
     * Отримує timestamp для завтрашнього дня (якщо доступний)
     */
    public getTomorrowTimestamp(): number | null {
        if (!this.cachedData || !this.cachedData.fact) {
            return null;
        }

        const todayTimestamp = this.cachedData.fact.today;
        const availableTimestamps = Object.keys(this.cachedData.fact.data)
            .map(ts => parseInt(ts))
            .filter(ts => ts > todayTimestamp);

        if (availableTimestamps.length === 0) {
            return null;
        }

        // Повертаємо найменший timestamp який більший за today
        return Math.min(...availableTimestamps);
    }

    /**
     * Парсить графік для конкретного timestamp
     */
    public parseGroupScheduleForDate(groupKey: string, timestamp: number): ParsedSchedule | null {
        if (!this.cachedData || !this.cachedData.fact || !this.cachedData.fact.data) {
            this.logger.warn('[OutageData] No cached data available for parsing');
            return null;
        }

        try {
            const timestampData = this.cachedData.fact.data[timestamp];
            if (!timestampData) {
                this.logger.warn(`[OutageData] No data found for timestamp ${timestamp}`);
                return null;
            }

            const formattedGroupKey = groupKey.startsWith('GPV') ? groupKey : `GPV${groupKey}`;

            if (!timestampData[formattedGroupKey]) {
                this.logger.warn(`[OutageData] Group ${formattedGroupKey} not found in timestamp ${timestamp}`);
                return null;
            }

            const schedule = this.normalizeSchedule(timestampData[formattedGroupKey]);

            return {
                timestamp: timestamp.toString(),
                schedule: schedule,
                lastUpdated: this.cachedData.lastUpdated,
                updateFact: this.cachedData.fact.updateFact
            };
        } catch (error: any) {
            this.logger.error(`[OutageData] Failed to parse schedule for timestamp ${timestamp}: ${error.message}`);
            return null;
        }
    }

    /**
     * Нормалізує ключі графіку (1..24 -> 0..23)
     */
    private normalizeSchedule(schedule: { [hour: string]: string }): { [hour: string]: string } {
        const keys = Object.keys(schedule).map(Number);
        if (keys.length === 0) return schedule;

        const minKey = Math.min(...keys);
        const maxKey = Math.max(...keys);

        // Якщо ключі 1..24, зміщуємо на -1 (0..23)
        if (minKey === 1 && maxKey === 24) {
            const normalized: { [hour: string]: string } = {};
            for (const key of Object.keys(schedule)) {
                const newKey = String(parseInt(key) - 1);
                normalized[newKey] = schedule[key];
            }
            return normalized;
        }
        return schedule;
    }

    /**
     * Форматує графік із схлопуванням періодів
     * @param schedule - Розпарсений графік
     * @param referenceDate - Дата для порівняння (для визначення минулого/поточного/майбутнього)
     */
    public formatScheduleWithPeriods(schedule: ParsedSchedule, referenceDate: Date = new Date(), showRelativeTimeEmojis: boolean = true): string {
        interface Period {
            startHour: number;
            startMinute: number;
            endHour: number;
            endMinute: number;
            status: string;
            isPast: boolean;
            isCurrent: boolean;
            isFuture: boolean;
        }

        const periods: Period[] = [];
        const hours = Object.keys(schedule.schedule).sort((a, b) => parseInt(a) - parseInt(b));

        let currentPeriod: Period | null = null;

        for (const hourStr of hours) {
            const hour = parseInt(hourStr);
            const status = schedule.schedule[hourStr];

            // Обробка "first" та "second" - розбиваємо годину на два періоди
            if (status === 'first') {
                // Перша половина години - немає світла
                if (currentPeriod && currentPeriod.status === 'no') {
                    currentPeriod.endHour = hour;
                    currentPeriod.endMinute = 30;
                } else {
                    if (currentPeriod) periods.push(currentPeriod);
                    currentPeriod = {
                        startHour: hour,
                        startMinute: 0,
                        endHour: hour,
                        endMinute: 30,
                        status: 'no',
                        isPast: false,
                        isCurrent: false,
                        isFuture: false
                    };
                }
                periods.push(currentPeriod);

                // Друга половина - є світло
                currentPeriod = {
                    startHour: hour,
                    startMinute: 30,
                    endHour: hour + 1,
                    endMinute: 0,
                    status: 'yes',
                    isPast: false,
                    isCurrent: false,
                    isFuture: false
                };
            } else if (status === 'second') {
                // Перша половина години - є світло
                if (currentPeriod && currentPeriod.status === 'yes') {
                    currentPeriod.endHour = hour;
                    currentPeriod.endMinute = 30;
                } else {
                    if (currentPeriod) periods.push(currentPeriod);
                    currentPeriod = {
                        startHour: hour,
                        startMinute: 0,
                        endHour: hour,
                        endMinute: 30,
                        status: 'yes',
                        isPast: false,
                        isCurrent: false,
                        isFuture: false
                    };
                }
                periods.push(currentPeriod);

                // Друга половина - немає світла
                currentPeriod = {
                    startHour: hour,
                    startMinute: 30,
                    endHour: hour + 1,
                    endMinute: 0,
                    status: 'no',
                    isPast: false,
                    isCurrent: false,
                    isFuture: false
                };
            } else {
                // Звичайний статус (yes/no)
                if (currentPeriod && currentPeriod.status === status) {
                    // Продовжуємо поточний період
                    currentPeriod.endHour = hour + 1;
                    currentPeriod.endMinute = 0;
                } else {
                    // Починаємо новий період
                    if (currentPeriod) periods.push(currentPeriod);
                    currentPeriod = {
                        startHour: hour,
                        startMinute: 0,
                        endHour: hour + 1,
                        endMinute: 0,
                        status: status,
                        isPast: false,
                        isCurrent: false,
                        isFuture: false
                    };
                }
            }
        }

        // Додаємо останній період
        if (currentPeriod) {
            // Якщо endHour = 24, виправляємо на 00:00
            if (currentPeriod.endHour === 24 && currentPeriod.endMinute === 0) {
                currentPeriod.endHour = 0;
            }
            periods.push(currentPeriod);
        }

        // Визначаємо минуле/поточне/майбутнє для кожного періоду
        const now = referenceDate;
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();

        for (const period of periods) {
            const startTime = period.startHour * 60 + period.startMinute;
            let endTime = period.endHour * 60 + period.endMinute;
            const nowTime = currentHour * 60 + currentMinute;


            // Якщо період закінчується о 00:00 (endHour=0), це кінець поточного дня
            // Перевіряємо чи ми вже пройшли цей період
            if (period.endHour === 0) {
                // Період закінчується опівночі (наприклад, 22:00-00:00)
                // Для порівняння: 00:00 стає 24:00 (1440 хвилин)
                endTime = 24 * 60;
            }


            if (endTime <= nowTime) {
                period.isPast = true;
            } else if (startTime <= nowTime && nowTime < endTime) {
                period.isCurrent = true;
            } else {
                period.isFuture = true;
            }
        }

        // Форматуємо періоди в текст
        const lines: string[] = [];
        let hoursWithLight = 0;
        let hoursWithoutLight = 0;

        for (const period of periods) {
            const startTime = `${String(period.startHour).padStart(2, '0')}:${String(period.startMinute).padStart(2, '0')}`;
            const endTime = `${String(period.endHour).padStart(2, '0')}:${String(period.endMinute).padStart(2, '0')}`;

            let prefixEmoji: string;
            if (!showRelativeTimeEmojis) {
                prefixEmoji = ''; // Без емодзі для майбутнього/минулого
            } else if (period.isPast) {
                prefixEmoji = '⏪'; // Минуле
            } else if (period.isCurrent) {
                prefixEmoji = '✅'; // Поточне
            } else {
                prefixEmoji = '⏩'; // Майбутнє
            }

            let statusEmoji: string;
            const calcEndHour = period.endHour === 0 ? 24 : period.endHour;
            const duration = (calcEndHour * 60 + period.endMinute - (period.startHour * 60 + period.startMinute)) / 60;

            if (period.status === 'yes') {
                statusEmoji = '💡';
                hoursWithLight += duration;
            } else {
                statusEmoji = '🌚';
                hoursWithoutLight += duration;
            }

            lines.push(`${prefixEmoji} ${startTime} - ${endTime} ${statusEmoji}`);
        }

        // Додаємо статистику
        lines.push('');
        lines.push(`📊 **Статистика:**`);
        lines.push(`💡 Зі світлом: ${hoursWithLight.toFixed(1)} год`);
        lines.push(`🌚 Без світла: ${hoursWithoutLight.toFixed(1)} год`);

        return lines.join('\n');
    }

    /**
     * Форматує дату оновлення у відносний час (наприклад, "23 хвилини тому")
     */
    public formatLastUpdated(isoString: string): string {
        const updated = new Date(isoString);
        const now = new Date();
        const diffMs = now.getTime() - updated.getTime();
        const diffMinutes = Math.floor(diffMs / (1000 * 60));

        if (diffMinutes < 1) {
            return 'щойно';
        } else if (diffMinutes < 60) {
            return `${diffMinutes} хв тому`;
        } else {
            const diffHours = Math.floor(diffMinutes / 60);
            if (diffHours < 24) {
                const remainingMinutes = diffMinutes % 60;
                if (remainingMinutes === 0) {
                    return `${diffHours} год тому`;
                }
                return `${diffHours} год ${remainingMinutes} хв тому`;
            } else {
                // Якщо більше доби - показуємо дату
                return updated.toLocaleString('uk-UA', {
                    day: 'numeric',
                    month: 'long',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            }
        }
    }
}
