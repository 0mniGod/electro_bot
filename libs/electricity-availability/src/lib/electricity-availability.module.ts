// ----- ФІНАЛЬНИЙ КОД (ВСТАВТЕ ЦЕЙ КОД) -----
import { Module } from '@nestjs/common';
import { ElectricityAvailabilityService } from './electricity-availability.service';
import { HttpModule } from '@nestjs/axios';
import { ElectricityRepository } from './electricity.repository'; // <-- Правильний відносний імпорт

@Module({
  imports: [HttpModule],
  providers: [ElectricityAvailabilityService, ElectricityRepository], // <-- Репозиторій додано сюди
  exports: [ElectricityAvailabilityService],
})
export class ElectricityAvailabilityModule {}
