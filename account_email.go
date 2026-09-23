// Email binding for accounts without a password (Discord OAuth users; PB gave them a random one
// they never saw).
// Stock confirm-email-change requires the account password → deadlock with password reset. Here
// proof of right = owning the NEW mailbox; afterwards the user sets a password via stock "forgot
// password".
// Token = PB NewEmailChangeToken (signed with record key, expires, dies when email/password
// changes). Own email template: the stock one links into the PB admin UI, which asks for the
// password again.
// Threats covered: hijacked session → notice to the OLD address; spam via our domain → 3
// tries/30min/account; grabbing someone's address → uniqueness checked at request AND at confirm.
package main

import (
	"html"
	"net/http"
	"net/mail"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/mailer"
	"github.com/pocketbase/pocketbase/tools/security"
)

const (
	emailLinkMax    = 3
	emailLinkWindow = 30 * time.Minute
)

type emailLinkRec struct {
	n     int
	until time.Time
}

type emailLinkCounter struct {
	mu   sync.Mutex
	hits map[string]emailLinkRec
}

var emailLinkTries = &emailLinkCounter{hits: map[string]emailLinkRec{}}

// Counts every attempt, not just successes: each attempt sends an email.
func (c *emailLinkCounter) take(key string) bool {
	if key == "" {
		return true
	}
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()

	// Prune expired entries here or the map grows forever (same bug the chat rate-limit maps had).
	for k, v := range c.hits {
		if now.After(v.until) {
			delete(c.hits, k)
		}
	}

	r, ok := c.hits[key]
	if !ok || now.After(r.until) {
		c.hits[key] = emailLinkRec{n: 1, until: now.Add(emailLinkWindow)}
		return true
	}
	if r.n >= emailLinkMax {
		return false
	}
	r.n++
	c.hits[key] = r
	return true
}

// Only trim + lowercase the domain. Local part is case-sensitive per RFC; gmail dot-folding is not
// our business.
func normalizeEmail(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

func validEmail(s string) bool {
	if s == "" || len(s) > 255 || strings.ContainsAny(s, " \t\r\n<>,;") {
		return false
	}
	addr, err := mail.ParseAddress(s)
	return err == nil && addr.Address == s
}

func senderAddress(app core.App) mail.Address {
	return mail.Address{
		Name:    app.Settings().Meta.SenderName,
		Address: app.Settings().Meta.SenderAddress,
	}
}

func registerAccountEmailRoutes(app *pocketbase.PocketBase, se *core.ServeEvent) {
	g := se.Router.Group("/api/custom/account")

	g.POST("/email/request", func(c *core.RequestEvent) error {
		if c.Auth == nil || c.Auth.Collection().Name != "users" {
			return c.UnauthorizedError("Sign in first.", nil)
		}

		var in struct {
			Email string `json:"email"`
		}
		if err := c.BindBody(&in); err != nil {
			return c.BadRequestError("Invalid body", err)
		}
		newEmail := normalizeEmail(in.Email)
		if !validEmail(newEmail) {
			return c.BadRequestError("That doesn't look like an email address.", nil)
		}
		if newEmail == normalizeEmail(c.Auth.Email()) {
			return c.BadRequestError("This address is already linked to your account.", nil)
		}

		// Check availability BEFORE sending, otherwise the user fails only at the very last step.
		if _, err := app.FindAuthRecordByEmail(c.Auth.Collection(), newEmail); err == nil {
			return c.BadRequestError("This address is already used by another account.", nil)
		}

		if !emailLinkTries.take(c.Auth.Id) {
			return apis.NewApiError(http.StatusTooManyRequests,
				"Too many attempts. Try again in half an hour.", nil)
		}

		token, err := c.Auth.NewEmailChangeToken(newEmail)
		if err != nil {
			return c.InternalServerError("Could not prepare the confirmation link.", err)
		}

		link := siteURL + "/confirm-email?token=" + token
		name := c.Auth.GetString("name")
		if name == "" {
			name = c.Auth.GetString("username")
		}

		client := app.NewMailClient()
		err = client.Send(&mailer.Message{
			From:    senderAddress(app),
			To:      []mail.Address{{Address: newEmail}},
			Subject: "Confirm your email for CYOA.CAFE",
			HTML: "<p>Hello, " + html.EscapeString(name) + ".</p>" +
				"<p>Someone (hopefully you) asked to link this address to the CYOA.CAFE account " +
				"<strong>" + html.EscapeString(c.Auth.GetString("username")) + "</strong>. " +
				"Confirm it and you'll be able to sign in by email and restore access if you ever lose it.</p>" +
				`<p><a href="` + link + `">Confirm this email address</a></p>` +
				"<p>If it wasn't you, just ignore this letter — nothing has changed yet.</p>",
		})
		if err != nil {
			return c.InternalServerError("Could not send the letter. Try again later.", err)
		}

		// Non-blocking: the old mailbox is often a dead Discord-sourced one; don't let it stall the user.
		if old := normalizeEmail(c.Auth.Email()); validEmail(old) {
			sendEmailChangeNotice(app, client, old, newEmail)
		}

		return c.JSON(http.StatusOK, map[string]any{"ok": true, "sent_to": newEmail})
	}).Bind(apis.RequireAuth())

	// No auth required: the link is often opened on a phone with no session. Mailbox ownership is the
	// credential.
	g.POST("/email/confirm", func(c *core.RequestEvent) error {
		var in struct {
			Token string `json:"token"`
		}
		if err := c.BindBody(&in); err != nil {
			return c.BadRequestError("Invalid body", err)
		}
		in.Token = strings.TrimSpace(in.Token)
		if in.Token == "" {
			return c.BadRequestError("No token.", nil)
		}

		// Read the email from the token only AFTER signature verification.
		rec, err := app.FindAuthRecordByToken(in.Token, core.TokenTypeEmailChange)
		if err != nil || rec == nil {
			return c.BadRequestError("This link is invalid or has expired.", nil)
		}
		if rec.Collection().Name != "users" {
			return c.BadRequestError("This link is invalid.", nil)
		}

		claims, _ := security.ParseUnverifiedJWT(in.Token)
		newEmail, _ := claims[core.TokenClaimNewEmail].(string)
		newEmail = normalizeEmail(newEmail)
		if !validEmail(newEmail) {
			return c.BadRequestError("This link is invalid.", nil)
		}

		// Re-check uniqueness: the address may have been taken (even by a fresh signup) between send and
		// click.
		if other, e := app.FindAuthRecordByEmail(rec.Collection(), newEmail); e == nil && other.Id != rec.Id {
			return c.BadRequestError("This address is already used by another account.", nil)
		}

		rec.SetEmail(newEmail)
		rec.SetVerified(true)
		if err := app.Save(rec); err != nil {
			return c.InternalServerError("Could not save the new address.", err)
		}

		return c.JSON(http.StatusOK, map[string]any{"ok": true, "email": newEmail})
	})
}

// The only protection for the old owner if the session is hijacked (OAuth accounts have no
// password). Errors swallowed: a dead old mailbox must not block binding.
func sendEmailChangeNotice(app core.App, client mailer.Mailer, oldEmail, newEmail string) {
	masked := maskEmail(newEmail)
	err := client.Send(&mailer.Message{
		From:    senderAddress(app),
		To:      []mail.Address{{Address: oldEmail}},
		Subject: "Someone is changing the email on your CYOA.CAFE account",
		HTML: "<p>A request was made to move your CYOA.CAFE account to <strong>" +
			html.EscapeString(masked) + "</strong>.</p>" +
			"<p>If that was you — nothing to do here, just follow the link we sent to the new address.</p>" +
			"<p><strong>If it wasn't you</strong>, someone has access to your account: sign in, change your " +
			"password, and write to us at " + html.EscapeString(app.Settings().Meta.SenderAddress) + ".</p>",
	})
	if err != nil {
		app.Logger().Warn("email change notice not delivered", "err", err)
	}
}

// The old mailbox may be read by the hijacker right now: reveal only enough for the owner to
// recognize the address.
func maskEmail(s string) string {
	at := strings.LastIndex(s, "@")
	if at <= 0 {
		return "***"
	}
	local, domain := s[:at], s[at:]
	if len(local) <= 1 {
		return "*" + domain
	}
	return local[:1] + strings.Repeat("*", 3) + domain
}
