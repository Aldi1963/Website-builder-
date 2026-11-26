package handler

import "testing"

// Bus: Publish -> Subscribe memutar ulang log (replay), lalu event live
// mengalir; Close menutup channel; Publish sesudah Close diabaikan;
// Subscribe ke topik tertutup tetap memutar ulang log lalu menutup.
func TestAgentEventBusReplayAndClose(t *testing.T) {
	bus := newAgentEventBus()
	bus.Publish(7, newAgentBusEvent("message", "halo"))
	bus.Publish(7, newAgentBusEvent("result", map[string]any{"status": "completed"}))

	ch, unsub := bus.Subscribe(7)
	defer unsub()
	ev1 := <-ch
	ev2 := <-ch
	if ev1.Type != "message" || ev1.Data != `"halo"` {
		t.Fatalf("replay pertama harus message/halo, dapat %+v", ev1)
	}
	if ev2.Type != "result" {
		t.Fatalf("replay kedua harus result, dapat %+v", ev2)
	}

	bus.Publish(7, newAgentBusEvent("message", "lagi"))
	ev3 := <-ch
	if ev3.Type != "message" || ev3.Data != `"lagi"` {
		t.Fatalf("event live harus message/lagi, dapat %+v", ev3)
	}

	bus.Close(7)
	if _, ok := <-ch; ok {
		t.Fatal("channel harus tertutup sesudah Close")
	}
	bus.Publish(7, newAgentBusEvent("message", "terlambat"))

	ch2, unsub2 := bus.Subscribe(7)
	defer unsub2()
	n := 0
	for range ch2 {
		n++
	}
	if n != 3 {
		t.Fatalf("harapkan 3 event replay dari topik tertutup, dapat %d", n)
	}
}

// Topik berbeda tidak saling mengganggu.
func TestAgentEventBusIsolation(t *testing.T) {
	bus := newAgentEventBus()
	bus.Publish(1, newAgentBusEvent("message", "satu"))
	ch, unsub := bus.Subscribe(2)
	defer unsub()
	bus.Publish(2, newAgentBusEvent("message", "dua"))
	ev := <-ch
	if ev.Data != `"dua"` {
		t.Fatalf("subscriber topik 2 harus menerima 'dua', dapat %+v", ev)
	}
	select {
	case extra := <-ch:
		t.Fatalf("subscriber topik 2 tidak boleh menerima event topik 1: %+v", extra)
	default:
	}
}
