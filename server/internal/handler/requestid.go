package handler

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

const requestIDKey = "webbuilder.request_id"

func newRequestID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "req-unknown"
	}
	return "req-" + hex.EncodeToString(b[:])
}

// RequestContext adds a safe correlation ID to every request and response.
// It deliberately records method/path/status only; headers, tokens and bodies
// are never logged.
func RequestContext() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader("X-Request-ID")
		if len(id) < 8 || len(id) > 80 {
			id = newRequestID()
		}
		c.Set(requestIDKey, id)
		c.Header("X-Request-ID", id)
		started := time.Now()
		c.Next()
		log.Printf("request_id=%s method=%s path=%s status=%d duration_ms=%d", id, c.Request.Method, c.Request.URL.Path, c.Writer.Status(), time.Since(started).Milliseconds())
	}
}

func RequestID(c *gin.Context) string {
	if value, ok := c.Get(requestIDKey); ok {
		if id, ok := value.(string); ok { return id }
	}
	return "req-unknown"
}

func JSONError(c *gin.Context, status int, message string) {
	c.JSON(status, gin.H{"error": message, "message": message, "requestId": RequestID(c)})
}

func requestIDHealth(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true, "requestId": RequestID(c)})
}
