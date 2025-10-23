import { Module } from '@nestjs/common';
import { ElectricityAvailabilityService } from './electricity-availability.service';
import { HttpModule } from '@nestjs/axios';
import { ElectricityRepository } from './electricity.repository';
import { ScheduleModule } from '@nestjs/schedule';
import { PlaceRepoModule } from '@electrobot/place-repo'; // <-- ДОДАНО ЦЕЙ ІМПОРТ

@Module({
  imports: [
    HttpModule,
    ScheduleModule.forRoot(),
    PlaceRepoModule, // <-- ДОДАНО ЦЕЙ МОДУЛЬ
  ],
  providers: [ElectricityAvailabilityService, ElectricityRepository],
  exports: [ElectricityAvailabilityService],
})
export class ElectricityAvailabilityModule {}
