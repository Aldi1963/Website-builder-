package handler

import (
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestRequestContextAddsCorrelationID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RequestContext())
	r.GET("/test", func(c *gin.Context) { c.JSON(200, gin.H{"requestId": RequestID(c)}) })
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/test", nil)
	r.ServeHTTP(w, req)
	if w.Code != 200 || w.Header().Get("X-Request-ID") == "" { t.Fatalf("missing request id: status=%d header=%q", w.Code, w.Header().Get("X-Request-ID")) }
}
