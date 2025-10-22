// ----- ФІНАЛЬНИЙ КОД (ВСТАВТЕ ЦЕЙ КОД) -----
import { Module } from '@nestjs/common';
import { ElectricityAvailabilityService } from './electricity-availability.service';
import { HttpModule } from '@nestjs/axios';
// Використовуємо бібліотечний шлях, оскільки ми щойно експортували репозиторій:
import { ElectricityRepository } from '@electrobot/electricity-availability';

@Module({
  imports: [HttpModule],
  providers: [ElectricityAvailabilityService, ElectricityRepository],
  exports: [ElectricityAvailabilityService],
})
export class ElectricityAvailabilityModule {}
