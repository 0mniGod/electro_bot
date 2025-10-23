import { Module } from '@nestjs/common';
import { ElectricityAvailabilityService } from './electricity-availability.service';
import { HttpModule } from '@nestjs/axios';
// KyivElectricstatusScheduleService та ScheduleModule видалені
import { ElectricityRepository } from './electricity.repository'; // Імпортуємо репозиторій
import { ScheduleModule } from '@nestjs/schedule'; // Повертаємо ScheduleModule

@Module({
  imports: [HttpModule, ScheduleModule.forRoot()], // Повертаємо ScheduleModule.forRoot()
  providers: [ElectricityAvailabilityService, ElectricityRepository], // <-- Додаємо ElectricityRepository
  exports: [ElectricityAvailabilityService],
})
export class ElectricityAvailabilityModule {}
