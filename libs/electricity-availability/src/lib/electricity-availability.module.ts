// ----- КОД "ПІСЛЯ" (ВСТАВТЕ ЦЕЙ КОД) -----
import { Module } from '@nestjs/common';
import { ElectricityAvailabilityService } from './electricity-availability.service';
import { HttpModule } from '@nestjs/axios';
// KyivElectricstatusScheduleService та ScheduleModule видалені

@Module({
  imports: [HttpModule], // ScheduleModule.forRoot() видалено
  providers: [ElectricityAvailabilityService], // KyivElectricstatusScheduleService видалено звідси
  exports: [ElectricityAvailabilityService],
})
export class ElectricityAvailabilityModule {}
