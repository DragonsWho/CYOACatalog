// usernames.go — вменяемые username при OAuth-регистрации + правило «сменить один раз».
//
// Зачем:
//   1. Discord/OIDC часто отдают ник, который не проходит паттерн поля username
//      (точки, юникод, слишком короткий) или уже занят — тогда PocketBase-ядро
//      генерит безликое `usersNNNNNN`. Хук перехватывает создание и кладёт в
//      CreateData осмысленный уникальный username (из ника → имени → email),
//      попутно заполняя пустой name.
//   2. updateRule коллекции = `id = @request.auth.id` разрешает юзеру править
//      свою запись, а PB-правила не умеют ограничивать ОТДЕЛЬНОЕ поле. Поэтому
//      «username можно сменить лишь однажды» держим серверным гардом: первая
//      смена разрешается и выставляет флаг username_locked, повторная — 403.
//
// Требует в коллекции users булево поле `username_locked` (default false).
package main

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// Паттерн поля username: ^[a-zA-Z0-9][a-zA-Z0-9_-]*[a-zA-Z0-9]$ (min 3, max 60).
var (
	usernameInvalidChars = regexp.MustCompile(`[^a-z0-9_-]+`)
	usernameEdgeTrim     = regexp.MustCompile(`^[_-]+|[_-]+$`)
)

const (
	usernameMinLen = 3
	usernameMaxLen = 60
)

// slugifyUsername приводит произвольную строку к валидному username или "".
// Регистр опускаем в нижний, чтобы не ловить коллизии по NOCASE-индексу.
func slugifyUsername(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = strings.ReplaceAll(s, " ", "-") // пробелы в display-имени → дефисы
	s = usernameInvalidChars.ReplaceAllString(s, "")
	s = usernameEdgeTrim.ReplaceAllString(s, "")
	if len(s) > usernameMaxLen {
		s = usernameEdgeTrim.ReplaceAllString(s[:usernameMaxLen], "")
	}
	if len(s) < usernameMinLen {
		return ""
	}
	return s
}

// cleanOAuthName убирает из отображаемого имени хвост-дискриминатор.
//
// PocketBase для Discord склеивает Name как `username#discriminator`
// (tools/auth/discord.go). Discord отменил дискриминаторы в 2023-м и с тех пор
// отдаёт всем "0" — в ник приезжает мёртвое «#0» («cat» → «cat#0»). Символ `#`
// в никах Discord запрещён, поэтому режем по ПОСЛЕДНЕЙ решётке и только у
// этого провайдера: у прочих `#` в имени — законная часть имени.
func cleanOAuthName(provider, name string) string {
	name = strings.TrimSpace(name)
	if provider != "discord" {
		return name
	}
	if i := strings.LastIndexByte(name, '#'); i > 0 {
		if trimmed := strings.TrimSpace(name[:i]); trimmed != "" {
			return trimmed
		}
	}
	return name
}

func emailLocalPart(email string) string {
	if i := strings.IndexByte(email, '@'); i > 0 {
		return email[:i]
	}
	return ""
}

// usernameTaken — регистронезависимая проверка занятости (индекс username NOCASE).
func usernameTaken(app core.App, username string) bool {
	var dummy int
	err := app.ConcurrentDB().
		Select("(1)").
		From("users").
		AndWhere(dbx.NewExp("username = {:u} COLLATE NOCASE", dbx.Params{"u": username})).
		Limit(1).
		Row(&dummy)
	return err == nil && dummy > 0
}

// uniqueUsername добивает базу до свободного, приписывая числовой суффикс.
func uniqueUsername(app core.App, base string) string {
	base = slugifyUsername(base)
	if base == "" {
		base = "user"
	}
	for len(base) < usernameMinLen {
		base += "0"
	}
	if !usernameTaken(app, base) {
		return base
	}
	for i := 2; i < 100000; i++ {
		suffix := strconv.Itoa(i)
		trimmed := base
		if len(trimmed)+len(suffix) > usernameMaxLen {
			trimmed = trimmed[:usernameMaxLen-len(suffix)]
		}
		candidate := trimmed + suffix
		if !usernameTaken(app, candidate) {
			return candidate
		}
	}
	return base // практически недостижимо
}

// registerUsernameHooks вешает оба хука. Вызывать до app.Start().
func registerUsernameHooks(app core.App) {
	// 1. OAuth-регистрация: осмысленный username вместо usersNNN + непустой name.
	app.OnRecordAuthWithOAuth2Request("users").BindFunc(func(e *core.RecordAuthWithOAuth2RequestEvent) error {
		if !e.IsNewRecord || e.OAuth2User == nil {
			return e.Next()
		}
		if e.CreateData == nil {
			e.CreateData = map[string]any{}
		}

		// username: подменяем только если клиент не прислал свой явно.
		if cur, _ := e.CreateData["username"].(string); strings.TrimSpace(cur) == "" {
			base := ""
			for _, cand := range []string{
				e.OAuth2User.Username,
				e.OAuth2User.Name,
				emailLocalPart(e.OAuth2User.Email),
			} {
				if s := slugifyUsername(cand); s != "" {
					base = s
					break
				}
			}
			e.CreateData["username"] = uniqueUsername(app, base)
		}

		// name: не оставляем пустым (иначе фронт-фолбэки и т.п.) и без хвоста
		// «#0» от Discord. Наш CreateData опережает штатный маппинг ядра
		// (record_auth_with_oauth2.go кладёт OAuth2User.Name только если поля нет),
		// так что чинить достаточно здесь.
		if cur, _ := e.CreateData["name"].(string); strings.TrimSpace(cur) == "" {
			name := cleanOAuthName(e.ProviderName, e.OAuth2User.Name)
			if name == "" {
				name, _ = e.CreateData["username"].(string)
			}
			e.CreateData["name"] = name
		}

		return e.Next()
	})

	// 2. Гард на self-update коллекции users. updateRule = `id=@request.auth.id`
	//    разрешает юзеру править свою запись, а PB-правила не умеют ограничивать
	//    отдельное поле. Поэтому:
	//      а) служебные поля не-суперюзеру ЗАПРЕЩЕНЫ вовсе (иначе самопроизвол в
	//         модераторы через `{isModerator:true}`, разлочка через
	//         `{username_locked:false}`, накрутка hosting-лимитов и т.п.);
	//      б) username меняется лишь однажды — первая смена ставит username_locked.
	//    Суперюзер (админка) не ограничен.
	app.OnRecordUpdateRequest("users").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		info, err := e.RequestInfo()
		if err != nil {
			return e.Next()
		}

		// (а) служебные поля — только сервер/админ.
		for _, f := range protectedUserFields {
			if _, ok := info.Body[f]; ok {
				return e.ForbiddenError("Field '"+f+"' can't be edited.", nil)
			}
		}

		// (б) username — не чаще одного раза.
		if raw, ok := info.Body["username"]; ok {
			newU, _ := raw.(string)
			newU = strings.TrimSpace(newU)
			// e.Record тут ещё держит текущее (сабмит формы — внутри e.Next()).
			oldU := e.Record.GetString("username")
			if newU != "" && newU != oldU {
				if e.Record.GetBool("username_locked") {
					return e.ForbiddenError("Username can only be changed once.", nil)
				}
				// Защёлкиваем флаг. username_locked в protectedUserFields → клиент
				// его прислать не мог, значит form.Submit не затрёт это значение.
				e.Record.Set("username_locked", true)
			}
		}

		return e.Next()
	})
}

// protectedUserFields — поля коллекции users, которые обычный юзер НЕ должен
// менять сам (только сервер-код через app.Save или суперюзер в админке).
// verified/email PB и так защищает (нужен manage-доступ) — их тут нет.
var protectedUserFields = []string{
	"isModerator",
	"is_reserved",
	"username_locked",
	"hosting_slug",
	"hosting_max_games",
	"hosting_max_upload_mb",
	"hosting_daily_uploaded",
	"hosting_daily_reset",
}
