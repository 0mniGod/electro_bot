// ----- ВСТАВТЕ ЦЕЙ КОД -----
import { Module } from '@nestjs/common';
import { ElectricityAvailabilityService } from './electricity-availability.service';
import { HttpModule } from '@nestjs/axios';
import { ElectricityRepository } from './electricity.repository'; // <-- Повертаємо відносний імпорт

@Module({
  imports: [HttpModule],
  // Вказуємо, що і сервіс, і репозиторій є частиною цього модуля:
  providers: [ElectricityAvailabilityService, ElectricityRepository],
  exports: [ElectricityAvailabilityService], // Експортуємо тільки сервіс (репозиторій - внутрішня деталь)
})
export class ElectricityAvailabilityModule {}
