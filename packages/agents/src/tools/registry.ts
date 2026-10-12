import type { AppConfig } from '@cms/core';

/** What a tool step may touch. Shown on the board ("Параметры"); enforced by its code. */
export interface ToolPermissions {
  reads: string[];
  writes: string[];
  /** External hosts it calls (empty = nothing leaves the computer). */
  hosts: string[];
}

export interface ToolDefinition {
  id: string;
  name: string;
  role: string;
  description: string;
  color: string;
  icon: string;
  permissions: (config: AppConfig) => ToolPermissions;
  /** Read-only parameters from .env (no secrets). */
  params: (config: AppConfig) => Record<string, string>;
}

const mb = (b: number) => `${Math.round(b / 1024 / 1024)} МБ`;
const min = (s: number) => `${Math.round(s / 60)} мин`;

const sttHosts = (c: AppConfig) =>
  c.media.sttProvider === 'cloud' ? ['облако STT (не подключено)'] : [];
const sttParams = (c: AppConfig) => ({
  'Движок (STT_PROVIDER)':
    c.media.sttProvider === 'local'
      ? `whisper.cpp, ${c.media.whisperModel ?? 'модель не указана'}`
      : c.media.sttProvider,
  'Язык (STT_LANGUAGE)': c.media.language,
  'Кусок (STT_CHUNK_SECONDS)': `${c.media.chunkSeconds} с`,
  'Хранение файлов (MEDIA_RETENTION_DAYS)': `${c.media.retentionDays} дн.`,
  ffmpeg: c.media.ffmpeg,
});

/**
 * Tool steps (stage 2.7): deterministic code with side effects or external engines. They are
 * not built in the constructor and have no prompt; the board shows "Параметры" instead.
 */
export const TOOLS: readonly ToolDefinition[] = [
  {
    id: 'stt_voice',
    name: 'Голос → текст',
    role: 'расшифровка голосовых',
    description:
      'Голосовое из Telegram или файл из панели → текст с таймкодами. Связью передаёт расшифровку агентам.',
    color: 'amber',
    icon: 'Г',
    permissions: (c) => ({
      reads: ['аудиофайл из хранилища'],
      writes: ['расшифровка (БД)', 'TXT/SRT/VTT/JSON в хранилище', 'расход по минутам'],
      hosts: sttHosts(c),
    }),
    params: (c) => ({
      ...sttParams(c),
      'Лимит размера (VOICE_MAX_MB)': mb(c.media.voiceMaxBytes),
      'Лимит длительности (VOICE_MAX_SECONDS)': min(c.media.voiceMaxSeconds),
    }),
  },
  {
    id: 'video_transcribe',
    name: 'Видео → текст',
    role: 'расшифровка и субтитры',
    description:
      'Видео из панели → аудиодорожка (ffmpeg) → куски → распознавание → текст, SRT, VTT, JSON. С прогрессом и отменой.',
    color: 'blue',
    icon: 'В',
    permissions: (c) => ({
      reads: ['видеофайл из хранилища'],
      writes: ['временные файлы (удаляются)', 'расшифровка (БД)', 'TXT/SRT/VTT/JSON', 'расход'],
      hosts: sttHosts(c),
    }),
    params: (c) => ({
      ...sttParams(c),
      'Лимит размера (VIDEO_MAX_MB)': mb(c.media.videoMaxBytes),
      'Лимит длительности (VIDEO_MAX_SECONDS)': min(c.media.videoMaxSeconds),
    }),
  },
  {
    id: 'kp_render',
    name: 'КП → DOCX/PDF',
    role: 'сборка документа КП',
    description:
      'Собирает DOCX и PDF из результата агента КП: позиции и суммы из справочника, итог посчитан кодом.',
    color: 'violet',
    icon: 'Д',
    permissions: () => ({
      reads: ['результат агента КП', 'справочник цен'],
      writes: ['DOCX и PDF в хранилище'],
      hosts: [],
    }),
    params: (c) => ({
      'Справочник (KP_CATALOG_FILE)': c.kp.catalogFile,
      'НДС (KP_VAT_PERCENT)': `${c.kp.vatPercent}%`,
    }),
  },
  {
    id: 'mailer_send',
    name: 'Отправка писем',
    role: 'рассылка после вашего подтверждения',
    description:
      'Отправляет утверждённое письмо только адресам с согласием: тест вам → «Отправить N адресам» → пачками, с остановкой.',
    color: 'pink',
    icon: 'О',
    permissions: (c) => ({
      reads: ['утверждённое письмо', 'контакты с согласием', 'список отписок'],
      writes: ['статусы отправки', 'отчёт'],
      hosts: c.mail.provider === 'mock' ? [] : ['почтовый сервис (не включён)'],
    }),
    params: (c) => ({
      'Отправка (MAIL_PROVIDER)':
        c.mail.provider === 'mock' ? 'mock — письма не уходят' : c.mail.provider,
      'Пачка (MAIL_BATCH_SIZE)': String(c.mail.batchSize),
      'Пауза между пачками': `${c.mail.batchPauseSeconds} с`,
      'Лимит в сутки (MAIL_MAX_PER_DAY)': String(c.mail.maxPerDay),
      'Тестовый адрес (MAIL_TEST_TO)': c.mail.testTo ? 'задан' : 'не задан',
      'Ссылка отписки (MAIL_UNSUBSCRIBE_URL)': c.mail.unsubscribeUrl ? 'задана' : 'не задана',
    }),
  },
];

export const toolById = (id: string) => TOOLS.find((t) => t.id === id);
