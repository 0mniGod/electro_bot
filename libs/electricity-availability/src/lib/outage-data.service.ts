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
            // Беремо перший (найновіший) timestamp з fact.data
            const timestamps = Object.keys(this.cachedData.fact.data);
            if (timestamps.length === 0) {
                this.logger.warn('[OutageData] No timestamps found in fact.data');
                return null;
            }

            // Сортуємо по спаданню, щоб взяти найновіший
            timestamps.sort((a, b) => parseInt(b) - parseInt(a));
            const latestTimestamp = timestamps[0];

            const timestampData = this.cachedData.fact.data[latestTimestamp];

            // Формуємо ключ групи у правильному форматі
            const formattedGroupKey = groupKey.startsWith('GPV') ? groupKey : `GPV${groupKey}`;

            if (!timestampData[formattedGroupKey]) {
                this.logger.warn(`[OutageData] Group ${formattedGroupKey} not found in data`);
                return null;
            }

            const schedule = timestampData[formattedGroupKey];

            this.logger.log(`[OutageData] Parsed schedule for ${formattedGroupKey}, timestamp: ${latestTimestamp}`);

            return {
                timestamp: latestTimestamp,
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
        return `${this.baseUrl}/images/kyiv/gpv-${cleanKey}-emergency.png`;
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

        // Сортуємо години
        const hours = Object.keys(schedule.schedule).sort((a, b) => parseInt(a) - parseInt(b));

        for (const hour of hours) {
            const status = schedule.schedule[hour];
            let emoji = '❔';
            let text = 'невідомо';

            if (status === 'yes') {
                emoji = '💡';
                text = 'є світло';
            } else if (status === 'no') {
                emoji = '🌚';
                text = 'немає світла';
            } else if (status === 'first') {
                emoji = '🕐';
                text = 'немає світла (1-а половина)';
            } else if (status === 'second') {
                emoji = '🕑';
                text = 'немає світла (2-а половина)';
            }

            lines.push(`${emoji} ${hour}:00 - ${text}`);
        }

        return lines.join('\n');
    }
}
