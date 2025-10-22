// ----- КОД "ПІСЛЯ" (ВСТАВТЕ ЦЕЙ КОД) -----
import { Module } from '@nestjs/common';
import { ElectricityAvailabilityService } from './electricity-availability.service';
import { HttpModule } from '@nestjs/axios';
import { ElectricityRepository } from '@electrobot/electricity-availability';

@Module({
  imports: [HttpModule],
  // Додаємо ElectricityRepository до списку providers:
  providers: [ElectricityAvailabilityService, ElectricityRepository],
  exports: [ElectricityAvailabilityService],
})
export class ElectricityAvailabilityModule {}
