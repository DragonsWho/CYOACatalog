package main

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type attentionTestApp struct {
	core.App
	db      *dbx.DB
	records map[string]*core.Record
	cursor  *core.Record
}

func (a *attentionTestApp) DB() dbx.Builder                                { return a.db }
func (a *attentionTestApp) RunInTransaction(fn func(core.App) error) error { return fn(a) }
func (a *attentionTestApp) FindFirstRecordByFilter(collection any, filter string, params ...dbx.Params) (*core.Record, error) {
	if collection == chatReadsCol && a.cursor != nil {
		return a.cursor, nil
	}
	return nil, errors.New("missing")
}
func (a *attentionTestApp) FindRecordById(collection any, id string, filters ...func(*dbx.SelectQuery) error) (*core.Record, error) {
	r := a.records[id]
	if r == nil {
		return nil, errors.New("missing")
	}
	return r, nil
}
func (a *attentionTestApp) FindCollectionByNameOrId(name string) (*core.Collection, error) {
	col := core.NewBaseCollection(name)
	col.Fields.Add(&core.TextField{Name: "user"}, &core.JSONField{Name: "cursors"})
	return col, nil
}
func (a *attentionTestApp) Save(model core.Model) error { a.cursor = model.(*core.Record); return nil }
func (a *attentionTestApp) FindRecordsByFilter(collection any, filter, sort string, limit, offset int, params ...dbx.Params) ([]*core.Record, error) {
	out := []*core.Record{}
	p := params[0]
	ids := map[string]bool{}
	if requested, ok := p["ids"].([]string); ok {
		for _, id := range requested {
			ids[id] = true
		}
	}
	through, _ := p["through"].(string)
	for _, r := range a.records {
		if r.Collection().Name == "notifications" &&
			!r.GetBool("read") &&
			r.GetString("recipient") == p["u"] &&
			(len(ids) == 0 || ids[r.Id]) &&
			(through == "" || r.GetString("created") <= through) {
			out = append(out, r)
		}
	}
	return out, nil
}

func attentionFixture(t *testing.T) *attentionTestApp {
	t.Helper()
	db, err := dbx.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	db.DB().SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	for _, sql := range []string{
		`CREATE TABLE shoutbox_blocks (user TEXT, blocked TEXT)`,
		`CREATE TABLE notifications (id TEXT, recipient TEXT, read INTEGER, type TEXT, shout_channel TEXT, shout_message TEXT)`,
		`CREATE TABLE shoutbox_channels (id TEXT, enabled INTEGER, is_dm INTEGER, is_private INTEGER, members TEXT)`,
		`CREATE TABLE shoutbox_messages (id TEXT, channel TEXT, user TEXT, created TEXT)`,
		`INSERT INTO shoutbox_channels VALUES ('dm',1,1,1,'["alice","bob"]'),('secret',1,1,1,'["bob","carol"]')`,
		`INSERT INTO shoutbox_messages VALUES ('m1','dm','bob','2026-09-19 10:00:00.100Z'),('m2','dm','bob','2026-09-19 10:00:00.200Z'),('m3','dm','alice','2026-09-19 10:00:00.300Z'),('hidden','secret','carol','2026-09-19 10:01:00.000Z')`,
		`INSERT INTO notifications VALUES ('n1','alice',0,'shout_dm','dm','m1'),('n2','alice',0,'shout_dm','dm','m2')`,
	} {
		if _, err := db.NewQuery(sql).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	a := &attentionTestApp{db: db, records: map[string]*core.Record{}}
	rooms := core.NewBaseCollection(shoutChannelsCol)
	rooms.Fields.Add(&core.BoolField{Name: "enabled"}, &core.BoolField{Name: "is_private"}, &core.JSONField{Name: "members"})
	for _, id := range []string{"dm", "secret"} {
		r := core.NewRecord(rooms)
		r.Id = id
		r.Set("enabled", true)
		r.Set("is_private", true)
		if id == "dm" {
			r.Set("members", []string{"alice", "bob"})
		} else {
			r.Set("members", []string{"bob", "carol"})
		}
		a.records[id] = r
	}
	msgs := core.NewBaseCollection(shoutboxCol)
	msgs.Fields.Add(&core.TextField{Name: "channel"}, &core.DateField{Name: "created"})
	for id, date := range map[string]string{"m1": "2026-09-19 10:00:00.100Z", "m2": "2026-09-19 10:00:00.200Z", "hidden": "2026-09-19 10:01:00.000Z"} {
		r := core.NewRecord(msgs)
		r.Id = id
		r.Set("channel", "dm")
		if id == "hidden" {
			r.Set("channel", "secret")
		}
		r.Set("created", date)
		a.records[id] = r
	}
	return a
}
func TestAttentionDMIndependentOfBell(t *testing.T) {
	a := attentionFixture(t)
	if _, err := a.db.NewQuery(`UPDATE notifications SET read=1`).Execute(); err != nil {
		t.Fatal(err)
	}
	out, err := chatAttention(a, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if out.Count != 0 || !out.Channels["dm"].DM || len(out.Channels) != 1 {
		t.Fatalf("unexpected summary: %+v", out)
	}
	expected, _ := time.Parse("2006-01-02 15:04:05.000Z", "2026-09-19 10:00:00.200Z")
	if out.Channels["dm"].Latest != expected.UnixMilli() {
		t.Fatal("own message changed the incoming cursor")
	}
}
func TestAttentionReadBoundedAndAuthorized(t *testing.T) {
	a := attentionFixture(t)
	if err := chatMarkRead(a, "alice", map[string]string{"dm": "m1", "secret": "hidden"}); err != nil {
		t.Fatal(err)
	}
	out, err := chatAttention(a, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if out.Count != 1 || out.Reads["dm"] >= out.Channels["dm"].Latest {
		t.Fatalf("newer message incorrectly read: %+v", out)
	}
	if _, ok := out.Reads["secret"]; ok {
		t.Fatal("private channel read leaked")
	}
	if err := chatMarkRead(a, "alice", map[string]string{"dm": "hidden"}); err != nil {
		t.Fatal(err)
	}
	if chatReadCursors(a, "alice")["dm"] != out.Reads["dm"] {
		t.Fatal("cross-channel message accepted")
	}
	if err := chatMarkRead(a, "alice", map[string]string{"dm": "m2"}); err != nil {
		t.Fatal(err)
	}
	if err := chatMarkRead(a, "alice", map[string]string{"dm": "m1"}); err != nil {
		t.Fatal(err)
	}
	final, err := chatAttention(a, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if final.Count != 0 || final.Reads["dm"] != final.Channels["dm"].Latest {
		t.Fatalf("read cursor regressed: %+v", final)
	}
}
func TestDirectPushCoalescingAndRetryPolicy(t *testing.T) {
	c := newCoalescer()
	sub := testSub("https://push.example/direct")
	for _, id := range []string{"a", "b", "c"} {
		c.queueDirect(nil, sub, pushPayload{Channel: "dm", Message: id, Body: id, DM: true})
	}
	if len(c.pend) != 1 {
		t.Fatalf("expected one pending conversation: %d", len(c.pend))
	}
	for _, p := range c.pend {
		if p.n != 2 || p.payload.Message != "c" || !p.urgent {
			t.Fatalf("lost direct payload: %+v", p)
		}
	}
	if _, retry := pushRetryDelay(&pushDeliveryError{status: 400}, 0); retry {
		t.Fatal("permanent error retried")
	}
	if _, retry := pushRetryDelay(&pushDeliveryError{status: 503}, 0); !retry {
		t.Fatal("temporary error not retried")
	}
	if delay, retry := pushRetryDelay(&pushDeliveryError{status: 429, after: 10 * time.Second}, 0); !retry || delay != 10*time.Second {
		t.Fatal("Retry-After ignored")
	}
	a := attentionFixture(t)
	if err := chatMarkRead(a, "alice", map[string]string{"dm": "m1"}); err != nil {
		t.Fatal(err)
	}
	if pushUnread(a, pushPayload{Recipient: "alice", Channel: "dm", Created: "2026-09-19 10:00:00.100Z"}) {
		t.Fatal("read push would be retried")
	}
	if !pushUnread(a, pushPayload{Recipient: "alice", Channel: "dm", Created: "2026-09-19 10:00:00.200Z"}) {
		t.Fatal("new push suppressed")
	}
}

func TestAttentionTraySnapshotDoesNotReadNewerCoalescedMessage(t *testing.T) {
	a := attentionFixture(t)
	col := core.NewBaseCollection("notifications")
	col.Fields.Add(&core.TextField{Name: "recipient"}, &core.TextField{Name: "shout_message"}, &core.BoolField{Name: "read"})
	n := core.NewRecord(col)
	n.Id = "n1"
	n.Set("recipient", "alice")
	n.Set("shout_message", "m2")
	a.records[n.Id] = n
	marked, err := chatMarkNotificationsRead(a, "alice", []string{"n1"}, map[string]string{"n1": "m1"}, "")
	if err != nil || len(marked) != 0 || n.GetBool("read") {
		t.Fatalf("stale tray read a newer message: %v %v", marked, err)
	}
	marked, err = chatMarkNotificationsRead(a, "alice", []string{"n1"}, map[string]string{"n1": "m2"}, "")
	if err != nil || len(marked) != 1 || !n.GetBool("read") {
		t.Fatalf("current tray did not clear: %v %v", marked, err)
	}
}

func TestAttentionTraySnapshotClearsUnreadBehindFirstPage(t *testing.T) {
	a := attentionFixture(t)
	a.records = map[string]*core.Record{}
	col := core.NewBaseCollection("notifications")
	col.Fields.Add(
		&core.TextField{Name: "recipient"},
		&core.TextField{Name: "shout_message"},
		&core.TextField{Name: "created"},
		&core.BoolField{Name: "read"},
	)
	for i := 0; i < 26; i++ {
		n := core.NewRecord(col)
		n.Id = fmt.Sprintf("n%02d", i)
		n.Set("recipient", "alice")
		n.Set("created", fmt.Sprintf("2026-09-19 10:00:%02d.000Z", i))
		a.records[n.Id] = n
	}

	// UI page holds only the newest 20 rows, but its newest timestamp bounds the whole snapshot: all
	// 25 unread clear in one request; the 26th (arrived after the snapshot) must survive.
	marked, err := chatMarkNotificationsRead(
		a,
		"alice",
		nil,
		nil,
		"2026-09-19 10:00:24.000Z",
	)
	if err != nil || len(marked) != 25 {
		t.Fatalf("hidden unread rows survived: marked=%d err=%v", len(marked), err)
	}
	if a.records["n25"].GetBool("read") {
		t.Fatal("notification newer than the tray snapshot was cleared")
	}
}
