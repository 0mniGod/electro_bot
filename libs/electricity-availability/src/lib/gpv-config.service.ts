import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

interface GpvConfig {
  gpvGroup: string;
  region: string;
}

@Injectable()
export class GpvConfigService {
  private readonly logger = new Logger(GpvConfigService.name);
  private readonly configPath: string;
  private cachedConfig: GpvConfig | null = null;

  constructor() {
    // Зберігаємо конфігурацію у кореневій директорії проекту
    this.configPath = path.join(process.cwd(), '.gpv-config.json');
    this.loadConfig();
  }

  /**
   * Завантажує конфігурацію з файлу при ініціалізації
   */
  private loadConfig(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf-8');
        this.cachedConfig = JSON.parse(data);

        // Перевіряємо чи встановлена потрібна група
        if (this.cachedConfig?.gpvGroup !== '28.1') {
          this.logger.warn(`GPV group was ${this.cachedConfig?.gpvGroup}. Changing to default 28.1.`);
          this.setGpvGroup('28.1', 'kyiv');
        } else {
          this.logger.log(`Loaded GPV configuration: Group ${this.cachedConfig?.gpvGroup}, Region ${this.cachedConfig?.region}`);
        }
      } else {
        this.logger.warn('GPV configuration file not found. Setting default group 28.1.');
        this.setGpvGroup('28.1', 'kyiv');
      }
    } catch (error) {
      this.logger.error(`Failed to load GPV configuration: ${error}`);
      this.cachedConfig = null;
    }
  }

  /**
   * Повертає поточну GPV групу або null якщо не налаштовано
   */
  public getGpvGroup(): string | null {
    return this.cachedConfig?.gpvGroup || null;
  }

  /**
   * Повертає поточний регіон або null якщо не налаштовано
   */
  public getRegion(): string | null {
    return this.cachedConfig?.region || null;
  }

  /**
   * Перевіряє, чи налаштована конфігурація
   */
  public isConfigured(): boolean {
    return this.cachedConfig !== null && !!this.cachedConfig.gpvGroup;
  }

  /**
   * Зберігає нову GPV групу
   * @param group - Номер групи у форматі "X.Y" (наприклад, "28.1")
   * @param region - Регіон (за замовчуванням "kyiv")
   */
  public setGpvGroup(group: string, region: string = 'kyiv'): void {
    const config: GpvConfig = {
      gpvGroup: group,
      region: region
    };

    try {
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
      this.cachedConfig = config;
      this.logger.log(`Saved GPV configuration: Group ${group}, Region ${region}`);
    } catch (error) {
      this.logger.error(`Failed to save GPV configuration: ${error}`);
      throw new Error('Failed to save GPV configuration');
    }
  }

  /**
   * Валідує формат GPV групи
   * @param group - Номер групи для валідації
   * @returns true якщо формат правильний
   */
  public validateGpvGroupFormat(group: string): boolean {
    // Формат має бути "число.число" (наприклад, "1.1", "28.1")
    const regex = /^\d+\.\d+$/;
    return regex.test(group);
  }

  /**
   * Отримує повну конфігурацію
   */
  public getConfig(): GpvConfig | null {
    return this.cachedConfig;
  }
}
