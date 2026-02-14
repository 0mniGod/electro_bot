import { Test, TestingModule } from '@nestjs/testing';
import { ScheduleCacheService } from './schedule-cache.service';
import { HttpService } from '@nestjs/axios';
import { NotificationBotService } from '@electrobot/bot';
import { GpvConfigService } from './gpv-config.service';
import { OutageDataService } from './outage-data.service';
import { TomorrowScheduleTrackerService } from './tomorrow-schedule-tracker.service';
import { of } from 'rxjs';

describe('ScheduleCacheService', () => {
    let service: ScheduleCacheService;
    let outageDataService: OutageDataService;
    let notificationBotService: NotificationBotService;

    const mockHttpService = {
        get: jest.fn(),
    };

    const mockNotificationBotService = {
        sendScheduleUpdateWithImage: jest.fn(),
        sendScrapedNotification: jest.fn(),
    };

    const mockGpvConfigService = {
        getGpvGroup: jest.fn().mockReturnValue('28.1'),
    };

    const mockOutageDataService = {
        fetchKyivSchedule: jest.fn(),
        parseGroupSchedule: jest.fn(),
        formatScheduleWithPeriods: jest.fn().mockReturnValue('Schedule Text'),
        formatLastUpdated: jest.fn().mockReturnValue('Just now'),
        getImageUrl: jest.fn().mockReturnValue('http://image.url'),
        getTomorrowTimestamp: jest.fn().mockReturnValue(null), // No tomorrow schedule for simplicity
        parseGroupScheduleForDate: jest.fn().mockReturnValue(null),
    };

    const mockTomorrowScheduleTracker = {
        getAndClearLastNotification: jest.fn().mockReturnValue(null),
        getAndClearLastNotificationImageUrl: jest.fn().mockReturnValue(null),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ScheduleCacheService,
                { provide: HttpService, useValue: mockHttpService },
                { provide: NotificationBotService, useValue: mockNotificationBotService },
                { provide: GpvConfigService, useValue: mockGpvConfigService },
                { provide: OutageDataService, useValue: mockOutageDataService },
                { provide: TomorrowScheduleTrackerService, useValue: mockTomorrowScheduleTracker },
            ],
        }).compile();

        service = module.get<ScheduleCacheService>(ScheduleCacheService);
        outageDataService = module.get<OutageDataService>(OutageDataService);
        notificationBotService = module.get<NotificationBotService>(NotificationBotService);
    });

    afterEach(() => {
        jest.clearAllMocks();
        // Reset private state if needed, though simpler to just recreate module
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    it('should NOT send notification if changes are due to day rollover', async () => {
        // 1. Setup - Initial fetch (Day 1)
        const day1Timestamp = 1700000000; // Some timestamp
        const day1Schedule = {
            timestamp: day1Timestamp.toString(),
            schedule: { '0': 'yes' }, // Simplified
            lastUpdated: new Date(day1Timestamp * 1000).toISOString(),
        };

        mockOutageDataService.fetchKyivSchedule.mockResolvedValue({});
        mockOutageDataService.parseGroupSchedule.mockReturnValue({
            schedule: day1Schedule.schedule,
            timestamp: day1Schedule.timestamp,
            lastUpdated: day1Schedule.lastUpdated
        });

        // First run - initializes cache
        await service.fetchAndCacheSchedules(true);
        // Should send startup notification
        expect(mockNotificationBotService.sendScheduleUpdateWithImage).toHaveBeenCalledTimes(1);
        mockNotificationBotService.sendScheduleUpdateWithImage.mockClear();

        // 2. Setup - Second fetch (Day 2 - Rollover)
        const day2Timestamp = day1Timestamp + 86400; // +24 hours
        const day2Schedule = {
            timestamp: day2Timestamp.toString(),
            schedule: { '0': 'yes' }, // Same schedule content, just different day
            lastUpdated: new Date(day2Timestamp * 1000).toISOString(),
        };

        mockOutageDataService.parseGroupSchedule.mockReturnValue({
            schedule: day2Schedule.schedule,
            timestamp: day2Schedule.timestamp,
            lastUpdated: day2Schedule.lastUpdated
        });

        // We need to simulate that "lastOutageSchedule" is set from previous run.
        // Since we reused the service instance, it should be set.

        // Run fetch again
        await service.fetchAndCacheSchedules(true);

        // 3. Verify
        // isDayRollover should detect the day change (Day 1 -> Day 2)
        // notification should be SKIPPED
        expect(mockNotificationBotService.sendScheduleUpdateWithImage).not.toHaveBeenCalled();
    });

    it('should send notification if changes are NOT rollover (same day update)', async () => {
        // 1. Setup - Initial fetch (Day 1)
        const day1Timestamp = 1700000000;
        const day1Schedule = {
            timestamp: day1Timestamp.toString(),
            schedule: { '0': 'yes' },
            lastUpdated: new Date(day1Timestamp * 1000).toISOString(),
        };

        mockOutageDataService.fetchKyivSchedule.mockResolvedValue({});
        mockOutageDataService.parseGroupSchedule.mockReturnValue({
            schedule: day1Schedule.schedule,
            timestamp: day1Schedule.timestamp,
            lastUpdated: day1Schedule.lastUpdated
        });

        await service.fetchAndCacheSchedules(true);
        mockNotificationBotService.sendScheduleUpdateWithImage.mockClear();

        // 2. Setup - Second fetch (Day 1 - Changed Content)
        const day1UpdatedTimestamp = day1Timestamp + 3600; // +1 hour, same day
        const day1UpdatedSchedule = {
            timestamp: day1UpdatedTimestamp.toString(),
            schedule: { '0': 'no' }, // CHANGED CONTENT
            lastUpdated: new Date(day1UpdatedTimestamp * 1000).toISOString(),
        };

        mockOutageDataService.parseGroupSchedule.mockReturnValue({
            schedule: day1UpdatedSchedule.schedule,
            timestamp: day1UpdatedSchedule.timestamp,
            lastUpdated: day1UpdatedSchedule.lastUpdated
        });

        await service.fetchAndCacheSchedules(true);

        // 3. Verify
        // notification SHOULD be sent
        expect(mockNotificationBotService.sendScheduleUpdateWithImage).toHaveBeenCalledTimes(1);
    });
    it('should detect day rollover even if state is updated before check (FAILING CASE REPRODUCTION)', async () => {
        // 1. Setup - Initial fetch (Day 1)
        const day1Timestamp = 1700000000;
        const day1Schedule = {
            timestamp: day1Timestamp.toString(),
            schedule: { '0': 'yes' },
            lastUpdated: new Date(day1Timestamp * 1000).toISOString(),
        };

        mockOutageDataService.fetchKyivSchedule.mockResolvedValue({});
        mockOutageDataService.parseGroupSchedule.mockReturnValue({
            schedule: day1Schedule.schedule,
            timestamp: day1Schedule.timestamp,
            lastUpdated: day1Schedule.lastUpdated
        });

        // Initial run
        await service.fetchAndCacheSchedules(true);
        mockNotificationBotService.sendScheduleUpdateWithImage.mockClear();

        // 2. Setup - Second fetch (Day 2 - Rollover)
        const day2Timestamp = day1Timestamp + 86400; // +24 hours
        const day2Schedule = {
            timestamp: day2Timestamp.toString(),
            schedule: { '0': 'yes' }, // Same content, different day
            lastUpdated: new Date(day2Timestamp * 1000).toISOString(),
        };

        mockOutageDataService.parseGroupSchedule.mockReturnValue({
            schedule: day2Schedule.schedule,
            timestamp: day2Schedule.timestamp,
            lastUpdated: day2Schedule.lastUpdated
        });

        // 3. Run
        await service.fetchAndCacheSchedules(true);

        // 4. Verify
        // If the bug exists (state updated before check), it will NOT detect rollover,
        // and thus it WILL send a notification (because timestamps changed, so it thinks it's an update).
        // WE WANT IT TO BE 0 calls (Rollover detected -> No notification).
        expect(mockNotificationBotService.sendScheduleUpdateWithImage).not.toHaveBeenCalled();
    });
});
