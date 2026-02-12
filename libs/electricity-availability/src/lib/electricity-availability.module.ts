import { forwardRef, Module } from '@nestjs/common';
import { ElectricityAvailabilityService } from './electricity-availability.service';
import { HttpModule } from '@nestjs/axios';
import { ScheduleModule } from '@nestjs/schedule';
import { BotModule } from '@electrobot/bot';
import { ScheduleCacheService } from './schedule-cache.service';
import { GpvConfigService } from './gpv-config.service';
import { OutageDataService } from './outage-data.service';

@Module({
  imports: [
    HttpModule,
    ScheduleModule.forRoot(),
    forwardRef(() => BotModule),
  ],
  providers: [
    ElectricityAvailabilityService,
    ScheduleCacheService,
    GpvConfigService,
    OutageDataService
  ],
  exports: [
    ElectricityAvailabilityService,
    ScheduleCacheService,
    GpvConfigService,
    OutageDataService
  ],
})
export class ElectricityAvailabilityModule { }
