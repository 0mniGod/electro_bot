/**
 * Тимчасовий скрипт для отримання emoji ID з набору esvitlo_uk
 * 
 * Інструкція:
 * 1. Запустіть: node emoji-id-logger.js
 * 2. Відкрийте Telegram і надішліть боту 4 емоджі з набору esvitlo_uk у такому порядку:
 *    - Анімована галочка ✓
 *    - Анімована лампочка 💡
 *    - Анімований хрестик ❌
 *    - Батарейка на зарядці 🔋
 * 3. Скопіюйте виведені ID і надішліть мені
 */

const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const token = process.env.BOT_TOKEN;

if (!token) {
    console.error('❌ Помилка: BOT_TOKEN не знайдено в .env файлі');
    process.exit(1);
}

console.log('🤖 Запускаю бота для логування emoji ID...');
console.log('📱 Надішліть мені кастомні емоджі з набору esvitlo_uk\n');

const bot = new TelegramBot(token, { polling: true });

let emojiCount = 0;
const expectedEmojis = [
    'Анімована галочка ✓',
    'Анімована лампочка 💡',
    'Анімований хрестик ❌',
    'Батарейка на зарядці 🔋'
];

bot.on('message', (msg) => {
    const chatId = msg.chat.id;

    // Перевіряємо чи є кастомні емоджі
    if (msg.entities && msg.entities.length > 0) {
        msg.entities.forEach((entity) => {
            if (entity.type === 'custom_emoji') {
                emojiCount++;
                const emojiName = expectedEmojis[emojiCount - 1] || `Emoji ${emojiCount}`;

                console.log(`\n✅ ${emojiName}`);
                console.log(`   ID: ${entity.custom_emoji_id}`);

                // Відповідаємо користувачу
                bot.sendMessage(chatId, `Отримано emoji #${emojiCount}\nID: ${entity.custom_emoji_id}`);

                // Якщо отримали всі 4 емоджі - виводимо фінальний результат
                if (emojiCount === 4) {
                    console.log('\n' + '='.repeat(60));
                    console.log('🎉 Всі emoji ID отримано! Скопіюйте цей блок:');
                    console.log('='.repeat(60));
                    process.exit(0);
                }
            }
        });
    } else {
        // Якщо надіслано звичайний текст/емоджі
        bot.sendMessage(
            chatId,
            '⚠️ Це не кастомний emoji.\n\n' +
            'Надішліть мені емоджі з набору esvitlo_uk:\n' +
            `${emojiCount + 1}. ${expectedEmojis[emojiCount]}`
        );
    }
});

bot.on('polling_error', (error) => {
    console.error('❌ Помилка polling:', error.message);
});

console.log('✅ Бот запущено! Очікую на емоджі...');
console.log(`📋 Надішліть емоджі #1: ${expectedEmojis[0]}\n`);
