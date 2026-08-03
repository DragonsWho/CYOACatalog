// Одна строка ленты чата v2, вынесенная из ChatLab и обёрнутая в React.memo.
//
// Строка дорогая: аватар, разметка текста с упоминаниями, подсказка со временем,
// до шести кнопок — и каждый MUI-компонент ещё и считает свои стили. Пока строка
// сидела прямо в ChatLab, любое состояние экрана (буква в поле ввода, ответ на
// пинг присутствия, наведение) перерисовывало ВСЮ историю: на длинной ленте это
// и была та самая «секунда на букву». Теперь ChatLab отдаёт готовые пропсы, а
// memo сравнивает их и пропускает строку, если ничего её не касается. Поэтому
// обработчики сюда обязаны приходить стабильными (useCallback в родителе):
// новая функция на каждый рендер сломала бы сравнение и всю экономию.

import { Fragment, memo } from 'react';
import { Link } from 'react-router-dom';
import {
  Avatar, Box, IconButton, Stack, Tooltip, Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DeleteForeverOutlinedIcon from '@mui/icons-material/DeleteForeverOutlined';
import VolumeOffOutlinedIcon from '@mui/icons-material/VolumeOffOutlined';
import ReplyOutlinedIcon from '@mui/icons-material/ReplyOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import CasinoOutlinedIcon from '@mui/icons-material/CasinoOutlined';
import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
import { chatTime, clockTime } from '../CyoaPage/Comments/relativeTime';
import { anonIdentity, nickColor } from '../Shoutbox/anonIdentity';
import { renderRichText } from '../Shoutbox/richText';
import { ShoutMessage, avatarUrlOf, messageImageUrl } from '../Shoutbox/shoutboxApi';

/** Черта с датой между днями. Благодаря ей у каждой реплики хватает голых часов
 *  («8:24 PM»): день уже назван выше, и полная дата в каждой строке читалась бы
 *  как лог, а не как разговор. */
function DayDivider({ label }: { label: string }) {
  return (
    <Box sx={{
      display: 'flex', alignItems: 'center', gap: 1, my: 1.25, px: 0.5,
    }}>
      <Box sx={{ flex: 1, height: '1px', bgcolor: 'divider' }} />
      <Typography
        variant="caption"
        sx={{
          fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
          color: 'text.secondary', px: 1, py: 0.25, borderRadius: 999,
          border: 1, borderColor: 'divider',
        }}
      >
        {label}
      </Typography>
      <Box sx={{ flex: 1, height: '1px', bgcolor: 'divider' }} />
    </Box>
  );
}

// Системные сообщения (новые игры, объявления) — отдельная плашка, а НЕ реплика
// с автором: у них нет ни юзера, ни anon_key, поэтому в общей ветке рендера они
// выходили безымянными «Anonymous». В v1 оформление уже было, при переписывании
// на v2 его забыли перенести — здесь оно повторено один в один.
function SystemLine({ m }: { m: ShoutMessage }) {
  const ev = m.event;
  let icon = <CampaignOutlinedIcon sx={{ fontSize: 14, opacity: 0.7 }} />;
  let body: React.ReactNode = m.text;
  if (ev?.type === 'new_game' && ev.games?.length) {
    icon = <CasinoOutlinedIcon sx={{ fontSize: 14, opacity: 0.7 }} />;
    body = (
      <>
        {ev.games.length === 1 ? 'New game: ' : `${ev.games.length} new games: `}
        {ev.games.map((g, i) => (
          <Fragment key={g.id}>
            {i > 0 && ', '}
            <Box
              component={Link}
              to={`/game/${g.id}`}
              sx={{ color: 'primary.light', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
            >
              {g.title}
            </Box>
            {ev.games.length === 1 && g.author !== 'unknown' && (
              <Box component="span" sx={{ opacity: 0.6 }}> by {g.author}</Box>
            )}
          </Fragment>
        ))}
      </>
    );
  }
  return (
    <Box data-mid={m.id} sx={{
      display: 'flex', alignItems: 'baseline', gap: 0.75,
      px: { xs: 0.75, sm: 1.25 }, py: 0.5, my: 0.25,
      borderRadius: 2, bgcolor: 'rgba(255,255,255,0.035)',
    }}>
      {icon}
      <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.5 }}>
        {body}
        {/* Голые часы, как у обычных реплик: день называет черта-разделитель
            выше, а полная дата в каждой строке читалась бы как лог. */}
        <Tooltip title={chatTime(m.created)} placement="top" enterDelay={400}>
          <Box component="span" sx={{ opacity: 0.45, ml: 0.75 }}>{clockTime(m.created)}</Box>
        </Tooltip>
      </Typography>
    </Box>
  );
}

export type MessageRowProps = {
  m: ShoutMessage;
  /** Подпись черты со сменой суток над строкой; пусто — черты нет. */
  daySepLabel?: string;
  /** Ярлык комнаты в слитной ленте: ставится только на смене комнаты. */
  chTitle?: string;
  /** Первая непрочитанная строка — над ней черта NEW. */
  unread: boolean;
  /** Продолжение блока того же автора: без аватарки и шапки. */
  grouped: boolean;
  /** Строку тронули пальцем: кнопки видны без наведения (телефон). */
  touched: boolean;
  isModerator: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Ник читателя — по нему подсвечиваются упоминания в тексте. */
  meUsername?: string;
  onTouch: (m: ShoutMessage) => void;
  onReply: (m: ShoutMessage) => void;
  onEdit: (m: ShoutMessage) => void;
  onDeleteOwn: (m: ShoutMessage) => void;
  onTogglePin: (m: ShoutMessage) => void;
  onModDelete: (m: ShoutMessage) => void;
  onModMute: (m: ShoutMessage) => void;
  onOpenProfile: (e: React.MouseEvent<HTMLElement>, m: ShoutMessage) => void;
  onMention: (username: string) => void;
};

function MessageRow({
  m, daySepLabel, chTitle, unread, grouped, touched, isModerator, canEdit, canDelete,
  meUsername, onTouch, onReply, onEdit, onDeleteOwn, onTogglePin, onModDelete, onModMute,
  onOpenProfile, onMention,
}: MessageRowProps) {
  // Смена суток — черта с датой. Считается до всего остального, чтобы
  // стоять и перед системной плашкой тоже.
  const daySep = daySepLabel ? <DayDivider label={daySepLabel} /> : null;
  // Системные — своей плашкой, до всей логики про автора: у них автора
  // нет вовсе, и общая ветка подписывала их «Anonymous».
  if (m.kind === 'system') {
    return <Fragment>{daySep}<SystemLine m={m} /></Fragment>;
  }
  const u = m.expand?.user;
  // Анонимную личину рисуем ТОЛЬКО настоящему анониму (есть anon_key).
  // Если у сообщения есть user, но expand не приехал (правила чтения
  // users, урезанный ответ), выдумывать ему «Anon Bat» нельзя: живой
  // человек оказался бы под чужим псевдонимом, а другое его сообщение
  // рядом — под настоящим именем.
  const anonId = !u && m.anon_key ? anonIdentity(m.anon_key) : null;
  // У части аккаунтов поле name пустое (регистрация через OAuth, старые
  // записи) — тогда показываем username. Без этого фолбэка человек с
  // пустым name выходил в чат под многоточием: имени нет, а анонимную
  // личину ему рисовать нельзя, он же не аноним. Именно это и было
  // видно как «ник не влезает, три точки».
  const displayName = u
    ? (u.name || u.username || 'User')
    : (anonId?.name ?? 'Anonymous');
  const img = messageImageUrl(m, '360x0');

  // Кнопки действий плавают в правом верхнем углу строки, а не стоят в
  // ряду с ником: у склеенного сообщения ника нет вовсе, и вешать их
  // было бы некуда. Заодно так же ведут себя все мессенджеры.
  const actions = (
    <Stack
      className="hov"
      direction="row"
      sx={{
        // На мышке кнопки проявляются наведением, на телефоне —
        // касанием строки: висеть постоянно они не могут, узкий экран
        // они перекрывают текстом наполовину.
        position: 'absolute', top: -10, right: 6, zIndex: 1,
        opacity: touched ? 1 : 0,
        transition: 'opacity .15s', bgcolor: 'background.paper',
        border: 1, borderColor: 'divider', borderRadius: 2, px: 0.25,
        boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
      }}
    >
      <IconButton size="small" title="Reply" sx={{ p: 0.25 }}
        onClick={() => onReply(m)}>
        <ReplyOutlinedIcon sx={{ fontSize: 14 }} />
      </IconButton>
      {canEdit && (
        <IconButton size="small" title="Edit my message" sx={{ p: 0.25 }}
          onClick={() => onEdit(m)}>
          <EditOutlinedIcon sx={{ fontSize: 14 }} />
        </IconButton>
      )}
      {canDelete && (
        <IconButton size="small" title="Delete my message" sx={{ p: 0.25 }}
          onClick={() => onDeleteOwn(m)}>
          <DeleteOutlineIcon sx={{ fontSize: 14 }} />
        </IconButton>
      )}
      {isModerator && (
        <>
          <IconButton size="small" title={m.pinned ? 'Unpin' : 'Pin in this room'}
            sx={{ p: 0.25, color: m.pinned ? 'warning.main' : undefined }}
            onClick={() => onTogglePin(m)}>
            <PushPinOutlinedIcon sx={{ fontSize: 14 }} />
          </IconButton>
          <IconButton size="small" title="Delete for everyone (moderator)"
            sx={{ p: 0.25, color: 'error.main' }} onClick={() => onModDelete(m)}>
            <DeleteForeverOutlinedIcon sx={{ fontSize: 14 }} />
          </IconButton>
          <IconButton size="small" title="Mute the author for 24h (moderator)"
            sx={{ p: 0.25, color: 'error.main' }} onClick={() => onModMute(m)}>
            <VolumeOffOutlinedIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </>
      )}
    </Stack>
  );

  return (
    <Fragment>
      {daySep}
      {unread && (
        <Stack direction="row" alignItems="center" spacing={1} sx={{ my: 0.5 }}>
          <Box sx={{ flex: 1, height: '1px', bgcolor: 'error.main', opacity: 0.5 }} />
          <Typography variant="caption" sx={{ color: 'error.main', fontSize: 10, letterSpacing: 0.5 }}>
            NEW
          </Typography>
          <Box sx={{ width: 12, height: '1px', bgcolor: 'error.main', opacity: 0.5 }} />
        </Stack>
      )}
      <Stack
        data-mid={m.id}
        direction="row"
        spacing={1.25}
        onClick={() => onTouch(m)}
        sx={{
          position: 'relative',
          py: grouped ? 0.2 : 0.85,
          // Небольшой отступ по бокам — чтобы подсветка (наведение,
          // закреп) не обрезала текст ровно по буквам.
          px: { xs: 0.75, sm: 1.25 },
          borderRadius: 2,
          '&:hover .hov': { opacity: 1 },
          // Наведение у закреплённого — тот же янтарь, только гуще.
          // Общий серый тут не годится: :hover перебивает базовый фон
          // по весу селектора, и подсветка закрепа пропадала ровно
          // тогда, когда на неё смотрят.
          ...(m.pinned
            ? {
              bgcolor: 'rgba(255,193,7,0.06)',
              // Полоска слева — чтобы закреп читался и на телефоне,
              // где мягкая заливка почти не видна на солнце.
              boxShadow: 'inset 2px 0 0 #ffc107',
              '&:hover': { bgcolor: 'rgba(255,193,7,0.11)' },
            }
            : { '&:hover': { bgcolor: 'rgba(255,255,255,0.035)' } }),
        }}
      >
        {grouped ? (
          // Место аватарки у склеенного сообщения занимает время — оно
          // проявляется при наведении. Ширина та же, чтобы текст всех
          // сообщений блока стоял ровно в одну колонку.
          <Box
            sx={{
              width: 32, flexShrink: 0, textAlign: 'right', lineHeight: '21px',
              // Время не переносится: в 28 пикселях «8:24 PM» ломалось на
              // три строки и раздувало каждую склеенную строку втрое.
              // Правым краем оно стоит ровно там, где кончается аватарка,
              // а лишнее уходит влево, в поле.
              whiteSpace: 'nowrap',
            }}
          >
            <Typography
              className="hov"
              variant="caption"
              sx={{ opacity: 0, transition: 'opacity .15s', fontSize: 9, color: 'text.secondary' }}
            >
              {clockTime(m.created)}
            </Typography>
          </Box>
        ) : (
          <Avatar
            src={avatarUrlOf(u)}
            sx={{
              width: 32, height: 32, fontSize: 14, mt: '1px',
              // Скруглённый квадрат вместо круга: аватарки в чате
              // мелкие, у «сквиркла» видно больше картинки, и лента
              // перестаёт выглядеть цепочкой пуговиц.
              borderRadius: '30%',
            }}
            variant="rounded"
          >
            {displayName[0]}
          </Avatar>
        )}
        <Box sx={{ minWidth: 0, flex: 1 }}>
          {!grouped && (
            <Stack direction="row" spacing={0.75} alignItems="baseline" sx={{ flexWrap: 'wrap', mb: 0.15 }}>
              <Typography
                variant="caption"
                onClick={(e) => onOpenProfile(e, m)}
                sx={{
                  fontSize: 13,
                  fontWeight: 700,
                  '&:hover': { textDecoration: u ? 'underline' : 'none' },
                  // Красный ник = модератор, и только он: в палитре ников
                  // красного нет намеренно, так что перепутать нельзя.
                  // Остальным цвет раздаётся по стабильному ключу — анониму
                  // по anon_key, зарегистрированному по id. Цвет тут не ранг,
                  // а узнавание: глаз ловит собеседника в ленте по пятну.
                  color: u?.isModerator
                    ? 'error.main'
                    : u
                      ? nickColor(u.id)
                      : (anonId?.color ?? 'text.primary'),
                  cursor: u ? 'pointer' : 'default',
                }}
              >
                {displayName}
              </Typography>
              {chTitle && (
                <Box sx={{
                  px: 0.6, borderRadius: 999, bgcolor: 'rgba(255,255,255,0.07)',
                  fontSize: 10, lineHeight: '15px', color: 'text.secondary',
                  whiteSpace: 'nowrap',
                }}>
                  #{chTitle}
                </Box>
              )}
              {/* Часы без даты: день назван чертой выше. Полная дата —
                  подсказкой при наведении, чтобы не потерять её совсем. */}
              <Tooltip title={chatTime(m.created)} placement="top" enterDelay={400}>
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: 11, opacity: 0.75 }}>
                  {clockTime(m.created)}
                </Typography>
              </Tooltip>
              {m.pinned && (
                <PushPinOutlinedIcon
                  titleAccess="Pinned"
                  sx={{ fontSize: 12, color: 'warning.main', alignSelf: 'center' }}
                />
              )}
            </Stack>
          )}
          {m.reply && (
            <Box
              sx={{
                borderLeft: 2, borderColor: 'primary.main', pl: 1, pr: 0.75, py: 0.25, mb: 0.35,
                borderRadius: '0 6px 6px 0', bgcolor: 'rgba(255,255,255,0.035)',
                color: 'text.secondary', fontSize: 12, lineHeight: 1.35,
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              <b>{m.reply.name || 'Anonymous'}</b>: {m.reply.text}
            </Box>
          )}
          {m.text && (
            <Typography
              variant="body2"
              sx={{
                wordBreak: 'break-word', whiteSpace: 'pre-wrap',
                fontSize: '0.9rem', lineHeight: 1.5,
              }}
            >
              {renderRichText(m.text, { onMention, me: meUsername })}
              {m.edited && (
                <Box component="span" sx={{ ml: 0.5, fontSize: 10, color: 'text.secondary' }}>
                  (edited)
                </Box>
              )}
            </Typography>
          )}
          {img && (
            <Box
              component="a"
              href={messageImageUrl(m)}
              target="_blank"
              rel="noreferrer"
              sx={{ display: 'inline-block', mt: 0.5 }}
            >
              <Box
                component="img"
                src={img}
                alt=""
                loading="lazy"
                sx={{
                  maxWidth: { xs: 220, sm: 260 }, maxHeight: 260, borderRadius: 2,
                  display: 'block', border: 1, borderColor: 'divider',
                }}
              />
            </Box>
          )}
        </Box>
        {actions}
      </Stack>
    </Fragment>
  );
}

export default memo(MessageRow);
