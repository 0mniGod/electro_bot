import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OutageDataService } from './outage-data.service';
import { GpvConfigService } from './gpv-config.service';

/**
 * Сервіс для відстеження завтрашнього графіка та автоматичних повідомлень
 */
@Injectable()
export class TomorrowScheduleTrackerService {
    private readonly logger = new Logger(TomorrowScheduleTrackerService.name);
    private lastKnownTomorrowTimestamp: number | null = null;
    private lastNotificationMessage: string | null = null;

    constructor(
        private readonly outageDataService: OutageDataService,
        private readonly gpvConfigService: GpvConfigService
    ) { }

    /**
     * Перевіряє наявність завтрашнього графіка кожні 15 хвилин
     */
    @Cron('*/15 * * * *')
    async checkForTomorrowSchedule() {
        try {
            await this.checkTomorrowSchedule();
        } catch (error: any) {
            this.logger.error(`[TomorrowTracker] Error checking tomorrow schedule: ${error.message}`);
        }
    }

    /**
     * Отримує останнє повідомлення про завтрашній графік (якщо є нове)
     * Потім скидає його, щоб не відправити двічі
     */
    public getAndClearLastNotification(): string | null {
        const message = this.lastNotificationMessage;
        this.lastNotificationMessage = null;
        return message;
    }

    /**
     * Перевіряє чи з'явився новий завтрашній графік
     */
    private async checkTomorrowSchedule(): Promise<void> {
        const tomorrowTimestamp = this.outageDataService.getTomorrowTimestamp();

        // Якщо завтрашнього графіка немає
        if (!tomorrowTimestamp) {
            this.logger.debug('[TomorrowTracker] No tomorrow schedule available yet');
            return;
        }

        // Якщо ми вже повідомили про цей timestamp
        if (this.lastKnownTomorrowTimestamp === tomorrowTimestamp) {
            this.logger.debug('[TomorrowTracker] Tomorrow schedule already notified');
            return;
        }

        this.logger.log(`[TomorrowTracker] New tomorrow schedule detected: timestamp ${tomorrowTimestamp}`);

        // Отримуємо налаштовану групу
        const gpvGroup = this.gpvConfigService.getGpvGroup();
        if (!gpvGroup) {
            this.logger.warn('[TomorrowTracker] No GPV group configured, skipping notification');
            return;
        }

        // Парсимо завтрашній графік
        const tomorrowSchedule = this.outageDataService.parseGroupScheduleForDate(gpvGroup, tomorrowTimestamp);
        if (!tomorrowSchedule) {
            this.logger.warn('[TomorrowTracker] Failed to parse tomorrow schedule');
            return;
        }

        // Перевіряємо чи це не placeholder
        if (this.outageDataService.isPlaceholderSchedule(tomorrowSchedule.schedule)) {
            this.logger.log('[TomorrowTracker] Tomorrow schedule is placeholder (all yes), skipping notification');
            return;
        }

        // Генеруємо повідомлення
        const message = this.generateTomorrowNotificationMessage(gpvGroup, tomorrowSchedule.schedule);

        // Зберігаємо для відправки
        this.lastNotificationMessage = message;

        // Запам'ятовуємо що вже повідомили
        this.lastKnownTomorrowTimestamp = tomorrowTimestamp;
        this.logger.log('[TomorrowTracker] Tomorrow schedule notification prepared');
    }

    /**
     * Генерує текст повідомлення про завтрашній графік
     */
    private generateTomorrowNotificationMessage(groupKey: string, schedule: { [hour: string]: string }): string {
        const parsedSchedule = {
            timestamp: 'tomorrow',
            schedule: schedule,
            lastUpdated: new Date().toISOString(),
            updateFact: undefined
        };

        // Форматуємо у завтрашній день (всі періоди будуть майбутні ⏭️)
        const tomorrowDate = new Date();
        tomorrowDate.setDate(tomorrowDate.getDate() + 1);
        tomorrowDate.setHours(0, 0, 0, 0);

        const formattedSchedule = this.outageDataService.formatScheduleWithPeriods(parsedSchedule, tomorrowDate);

        return `📅 **Графік на завтра став доступний!**\n\nГрупа: ${groupKey}\n\n${formattedSchedule}`;
    }
}
