package main

// Пробелы по краям названий — невидимый источник дублей.
//
// «The Unseen Trial » и «The Unseen Trial» — для человека одна игра, для
// PB-фильтра `title="…"` две разные записи: слияльщик (hub_tools/merge_games)
// собирал группу одноимённых и находил в ней ровно одну карточку, «сливать
// нечего». Тот же пробел ломает любой exact-поиск по названию: тег-мапу,
// дедуп очереди, сверку с каталогом.
//
// Чинить каждый вход по отдельности (форма добавления, ночной пайплайн,
// PB-скрипты, админка) бессмысленно — их много и будут новые. Режем один раз
// на записи в БД: любой путь, который идёт через PocketBase, приходит сюда.
//
// Правило узкое НАРОЧНО: только края и только схлопывание внутренних пробелов
// в один. Регистр, пунктуацию и эмодзи не трогаем — это уже редактура чужого
// названия, а не гигиена.

import (
	"regexp"
	"strings"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

// поля-названия, которые нормализуем: коллекция → поле
var trimmedNameFields = map[string]string{
	"games":   "title",
	"authors": "name",
	"tags":    "name",
}

// \s в Go не покрывает NBSP и zero-width — перечисляем «невидимки» явно.
var innerSpaceRe = regexp.MustCompile("[\\s\u00a0\u200b\ufeff]+")

// normalizeName схлопывает любую пробельную последовательность в один пробел и
// срезает края. Невидимки из копипасты (NBSP, zero-width, BOM) считаем
// пробелом: глазами они неотличимы, а exact-фильтр расходится по ним ровно так
// же, как по обычному хвостовому пробелу.
func normalizeName(s string) string {
	return strings.TrimSpace(innerSpaceRe.ReplaceAllString(s, " "))
}

// registerNameTrim вешает нормализацию на create/update названий каталога.
//
// Хук games-create обязан отработать ДО минтинга слага в registerGameEdits
// (иначе slug мы считали бы от «грязного» названия), поэтому вызывать эту
// регистрацию нужно раньше registerGameEdits — порядок хуков в PocketBase =
// порядок BindFunc. На деле slugifyGame и так режет края, так что это не
// корректность, а предсказуемость.
func registerNameTrim(app *pocketbase.PocketBase) {
	for coll, field := range trimmedNameFields {
		coll, field := coll, field
		trim := func(e *core.RecordEvent) error {
			raw := e.Record.GetString(field)
			if clean := normalizeName(raw); clean != raw {
				e.Record.Set(field, clean)
				e.App.Logger().Info("name trimmed",
					"collection", coll, "record", e.Record.Id,
					"from", raw, "to", clean)
			}
			return e.Next()
		}
		app.OnRecordCreate(coll).BindFunc(trim)
		app.OnRecordUpdate(coll).BindFunc(trim)
	}
}
