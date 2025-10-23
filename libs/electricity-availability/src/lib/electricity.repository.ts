import { HistoryItem } from './history-item.type';
import { Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { InjectModel } from 'nestjs-knex';

const TABLE_NAME = 'availability';

@Injectable()
export class ElectricityRepository {
  private readonly logger = new Logger(ElectricityRepository.name);
  constructor(@InjectModel() private readonly knex: Knex) {}

  public async save(params: {
    readonly placeId: string;
    readonly isAvailable: boolean;
  }): Promise<void> {
    const { placeId, isAvailable } = params;
    this.logger.debug(`Saving availability for place ${placeId}: ${isAvailable}`);
    await this.knex(TABLE_NAME).insert({
      place_id: placeId,
      is_available: isAvailable,
      created_at: new Date(),
    });
  }

  public async getLatest(params: {
    readonly placeId: string;
    readonly limit: number;
    readonly to?: Date;
  }): Promise<
    ReadonlyArray<{
      readonly time: Date;
      readonly isAvailable: boolean;
    }>
  > {
    const { placeId, limit, to } = params;
    this.logger.debug(`Getting latest availability for place ${placeId} (limit ${limit}, to ${to})`);
    let query = this.knex(TABLE_NAME)
      .select('created_at', 'is_available')
      .where('place_id', placeId)
      .orderBy('created_at', 'desc')
      .limit(limit);

    if (to) {
      query = query.andWhere('created_at', '<=', to);
    }

    const res: Array<{
      created_at: Date;
      is_available: boolean;
    }> = await query;

    return res.map((r) => ({
      time: r.created_at,
      isAvailable: r.is_available,
    }));
  }

  public async getHistory(params: {
    readonly placeId: string;
    readonly from: Date;
    readonly to: Date;
  }): Promise<ReadonlyArray<HistoryItem>> {
    const { placeId, from, to } = params;
    this.logger.debug(`Getting history for place ${placeId} from ${from} to ${to}`);

    // Знаходимо останній запис ПЕРЕД початком інтервалу
    const [lastStateBefore] = await this.getLatest({ placeId, limit: 1, to: from });

    // Знаходимо всі записи ВСЕРЕДИНІ інтервалу
    const history: Array<{
      created_at: Date;
      is_available: boolean;
    }> = await this.knex(TABLE_NAME)
        .select('created_at', 'is_available')
        .where('place_id', placeId)
        .andWhere('created_at', '>=', from)
        .andWhere('created_at', '<=', to)
        .orderBy('created_at', 'asc');

    if (!history.length && !lastStateBefore) {
        this.logger.warn(`No history found for place ${placeId} in time range.`);
        return []; // Немає даних
    }

    // Визначаємо початковий стан
    const startState = lastStateBefore ? lastStateBefore.isAvailable : history[0].isAvailable;
    const result: HistoryItem[] = [];

    // Додаємо початковий елемент
    result.push({
        start: from,
        end: history.length ? history[0].created_at : to,
        isEnabled: startState,
    });

    // Обробляємо елементи всередині інтервалу
    history.forEach((item, i) => {
        const nextItem = history[i + 1];
        result.push({
            start: item.created_at,
            end: nextItem ? nextItem.created_at : to,
            isEnabled: item.is_available,
        });
    });

    return result;
  }
}
