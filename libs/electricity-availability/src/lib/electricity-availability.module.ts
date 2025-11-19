import { forwardRef, Module } from '@nestjs/common';
import { ElectricityAvailabilityService } from './electricity-availability.service';
import { HttpModule } from '@nestjs/axios';
import { ScheduleModule } from '@nestjs/schedule';
import { BotModule } from '@electrobot/bot';
import { ScheduleCacheService } from './schedule-cache.service';

@Module({
  imports: [
    HttpModule,
    ScheduleModule.forRoot(),
    forwardRef(() => BotModule),
  ],
  providers: [ElectricityAvailabilityService, ScheduleCacheService],
  exports: [ElectricityAvailabilityService, ScheduleCacheService],
})
export class ElectricityAvailabilityModule { }
