import { forwardRef, Module } from '@nestjs/common'; // <-- ДОДАНО forwardRef
import { ElectricityAvailabilityService } from './electricity-availability.service';
import { HttpModule } from '@nestjs/axios';
import { ElectricityRepository } from './electricity.repository';
import { ScheduleModule } from '@nestjs/schedule';
import { PlaceRepoModule } from '@electrobot/place-repo';
import { BotModule } from '@electrobot/bot'; // Імпорт залишається

@Module({
  imports: [
    HttpModule,
    ScheduleModule.forRoot(),
    PlaceRepoModule,
    forwardRef(() => BotModule), // <-- ВИПРАВЛЕНО
  ],
  providers: [ElectricityAvailabilityService, ElectricityRepository],
  exports: [ElectricityAvailabilityService],
})
export class ElectricityAvailabilityModule {}
