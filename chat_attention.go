package main

import (
	"net/http"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

const chatReadsCol = "chat_read_cursors"

type chatAttentionChannel struct {
	Latest int64 `json:"latest"`
	DM     bool  `json:"dm"`
}
type chatAttentionSummary struct {
	Count         int                             `json:"count"`
	Channels      map[string]chatAttentionChannel `json:"channels"`
	Reads         map[string]int64                `json:"reads"`
	Notifications map[string]int                  `json:"notifications"`
}

func chatReadCursors(app core.App, uid string) map[string]int64 {
	reads := map[string]int64{}
	rec, err := app.FindFirstRecordByFilter(chatReadsCol, "user = {:u}", dbx.Params{"u": uid})
	if err == nil {
		_ = rec.UnmarshalJSONField("cursors", &reads)
		if reads == nil {
			reads = map[string]int64{}
		}
		return reads
	}
	for ch, at := range shoutStateOf(app, uid).Reads {
		if _, ok := reads[ch]; !ok {
			reads[ch] = at * 1000
		}
	}
	return reads
}

func chatAttention(app core.App, uid string) (chatAttentionSummary, error) {
	out := chatAttentionSummary{Channels: map[string]chatAttentionChannel{}, Reads: chatReadCursors(app, uid), Notifications: map[string]int{}}
	var counts []struct {
		Channel string `db:"channel"`
		N       int    `db:"n"`
	}
	err := app.DB().NewQuery(`SELECT shout_channel AS channel, COUNT(*) AS n FROM notifications WHERE recipient={:u} AND read=0 GROUP BY shout_channel`).Bind(dbx.Params{"u": uid}).All(&counts)
	if err != nil {
		return out, err
	}
	for _, row := range counts {
		out.Count += row.N
		if row.Channel != "" {
			out.Notifications[row.Channel] = row.N
		}
	}
	var latest []struct {
		Channel string `db:"channel"`
		Created string `db:"created"`
		DM      bool   `db:"dm"`
	}
	// The notification feed is rate-limited; DM unread state must come from messages.
	err = app.DB().NewQuery(`SELECT c.id AS channel, COALESCE((SELECT m.created FROM shoutbox_messages m
 WHERE m.channel=c.id AND m.user!={:u}
 AND NOT EXISTS (SELECT 1 FROM shoutbox_blocks b WHERE b.user={:u} AND b.blocked=m.user)
 ORDER BY m.created DESC LIMIT 1), '') AS created, 1 AS dm
 FROM shoutbox_channels c
 WHERE c.enabled=1 AND c.is_dm=1 AND EXISTS (SELECT 1 FROM json_each(c.members) WHERE value={:u})
 UNION ALL
 SELECT n.shout_channel AS channel, MAX(m.created) AS created, 0 AS dm
 FROM notifications n JOIN shoutbox_messages m ON m.id=n.shout_message
 JOIN shoutbox_channels c ON c.id=n.shout_channel
 WHERE n.recipient={:u} AND n.type IN ('shout_reply','shout_mention') AND c.enabled=1
 AND (c.is_private=0 OR EXISTS (SELECT 1 FROM json_each(c.members) WHERE value={:u}))
 AND NOT EXISTS (SELECT 1 FROM shoutbox_blocks b WHERE b.user={:u} AND b.blocked=m.user)
 GROUP BY n.shout_channel`).Bind(dbx.Params{"u": uid}).All(&latest)
	if err != nil {
		return out, err
	}
	for _, row := range latest {
		at, err := time.Parse("2006-01-02 15:04:05.000Z", row.Created)
		if err != nil {
			continue
		}
		old := out.Channels[row.Channel]
		if at.UnixMilli() > old.Latest {
			old.Latest = at.UnixMilli()
		}
		old.DM = old.DM || row.DM
		out.Channels[row.Channel] = old
	}
	return out, nil
}

func chatMarkRead(app core.App, uid string, messages map[string]string) error {
	return app.RunInTransaction(func(tx core.App) error {
		reads := chatReadCursors(tx, uid)
		changed := false
		for ch, id := range messages {
			room, err := tx.FindRecordById(shoutChannelsCol, ch)
			if err != nil || !room.GetBool("enabled") {
				continue
			}
			if room.GetBool("is_private") {
				allowed := false
				for _, member := range room.GetStringSlice("members") {
					if member == uid {
						allowed = true
					}
				}
				if !allowed {
					continue
				}
			}
			msg, err := tx.FindRecordById(shoutboxCol, id)
			if err != nil || msg.GetString("channel") != ch {
				continue
			}
			at := msg.GetDateTime("created").Time().UnixMilli()
			if at > reads[ch] {
				reads[ch] = at
				changed = true
			}
			_, err = tx.DB().NewQuery(`UPDATE notifications SET read=1 WHERE recipient={:u} AND shout_channel={:ch} AND read=0
    AND shout_message IN (SELECT id FROM shoutbox_messages WHERE channel={:ch} AND created <= {:created})`).Bind(dbx.Params{"u": uid, "ch": ch, "created": msg.GetString("created")}).Execute()
			if err != nil {
				return err
			}
		}
		if !changed {
			return nil
		}
		rec, err := tx.FindFirstRecordByFilter(chatReadsCol, "user = {:u}", dbx.Params{"u": uid})
		if err != nil {
			col, err := tx.FindCollectionByNameOrId(chatReadsCol)
			if err != nil {
				return err
			}
			rec = core.NewRecord(col)
			rec.Set("user", uid)
		}
		rec.Set("cursors", reads)
		return tx.Save(rec)
	})
}

func chatMarkNotificationsRead(app core.App, uid string, ids []string, messages map[string]string, through string) ([]string, error) {
	marked := []string{}
	err := app.RunInTransaction(func(tx core.App) error {
		filter := "recipient={:u} && read=false"
		params := dbx.Params{"u": uid}
		if through != "" {
			// The tray is paginated, so an id-only update never reaches unread rows past page 1. Clear the
			// whole server snapshot instead; rows created/coalesced after the snapshot stay unread (their
			// created ts is past the boundary).
			filter += " && created <= {:through}"
			params["through"] = through
		} else if len(ids) > 0 {
			filter += " && id IN {:ids}"
			params["ids"] = ids
		}
		records, err := tx.FindRecordsByFilter("notifications", filter, "", 0, 0, params)
		if err != nil {
			return err
		}
		for _, n := range records {
			// A coalesced row may now point to a message newer than the tray snapshot.
			if message, ok := messages[n.Id]; ok && n.GetString("shout_message") != message {
				continue
			}
			n.Set("read", true)
			if err := tx.Save(n); err != nil {
				return err
			}
			marked = append(marked, n.Id)
		}
		return nil
	})
	return marked, err
}

func registerChatAttention(app *pocketbase.PocketBase, g *router.RouterGroup[*core.RequestEvent]) {
	if _, err := app.FindCollectionByNameOrId(chatReadsCol); err != nil {
		col := core.NewBaseCollection(chatReadsCol)
		col.Fields.Add(&core.TextField{Name: "user", Required: true}, &core.JSONField{Name: "cursors", MaxSize: 200000})
		col.AddIndex("idx_chat_read_user", true, "user", "")
		if err := app.Save(col); err != nil {
			app.Logger().Error("chat read schema", "error", err)
		}
	}
	g.GET("/attention", func(c *core.RequestEvent) error {
		out, err := chatAttention(app, c.Auth.Id)
		if err != nil {
			return c.InternalServerError("Could not load chat attention", err)
		}
		return c.JSON(http.StatusOK, out)
	}).Bind(apis.RequireAuth())
	g.POST("/read", func(c *core.RequestEvent) error {
		var body struct {
			Messages map[string]string `json:"messages"`
		}
		if err := c.BindBody(&body); err != nil || len(body.Messages) > 100 {
			return c.BadRequestError("Invalid read cursors", err)
		}
		if err := chatMarkRead(app, c.Auth.Id, body.Messages); err != nil {
			return c.InternalServerError("Could not save read cursors", err)
		}
		return c.JSON(http.StatusOK, map[string]bool{"ok": true})
	}).Bind(apis.RequireAuth())
}
