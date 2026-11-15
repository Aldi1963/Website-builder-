package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"
)

func init() { gin.SetMode(gin.TestMode) }

func doJSON(t *testing.T, h gin.HandlerFunc, method, target, body string, setup func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
	} else {
		r = httptest.NewRequest(method, target, nil)
	}
	r.Header.Set("Content-Type", "application/json")
	if setup != nil {
		setup(r)
	}
	c, _ := gin.CreateTestContext(w)
	c.Request = r
	h(c)
	return w
}

func mustParseToken(t *testing.T, tok, secret string) jwt.MapClaims {
	t.Helper()
	parsed, err := jwt.Parse(tok, func(t *jwt.Token) (interface{}, error) { return []byte(secret), nil })
	if err != nil || !parsed.Valid {
		t.Fatalf("token hasil handler tidak valid: %v", err)
	}
	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		t.Fatal("claims bukan MapClaims")
	}
	return claims
}

func TestRegisterValidation(t *testing.T) {
	db := openTestDB(t)
	h := handleRegister(db)

	// Password < 6 karakter ditolak.
	w := doJSON(t, h, "POST", "/api/auth/register", `{"name":"A","email":"a@x.id","password":"123"}`, nil)
	if w.Code != 400 {
		t.Fatalf("password pendek: mau 400, dapat %d (%s)", w.Code, w.Body.String())
	}
	// Email tidak valid ditolak.
	w = doJSON(t, h, "POST", "/api/auth/register", `{"name":"A","email":"bukan-email","password":"rahasia1"}`, nil)
	if w.Code != 400 {
		t.Fatalf("email jelek: mau 400, dapat %d", w.Code)
	}
	// Sukses -> 201 + token JWT berisi uid user yang dibuat.
	w = doJSON(t, h, "POST", "/api/auth/register", `{"name":"A","email":"a@x.id","password":"rahasia1"}`, nil)
	if w.Code != 201 {
		t.Fatalf("register sah: mau 201, dapat %d (%s)", w.Code, w.Body.String())
	}
	var out struct {
		Token string      `json:"token"`
		User  models.User `json:"user"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.User.ID == 0 || out.Token == "" {
		t.Fatalf("respons register tidak lengkap: %+v", out)
	}
	// Password tersimpan sebagai hash bcrypt, bukan plaintext.
	var stored models.User
	db.First(&stored, out.User.ID)
	if stored.Password == "rahasia1" {
		t.Fatal("password tersimpan plaintext")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(stored.Password), []byte("rahasia1")); err != nil {
		t.Fatal("hash bcrypt tidak cocok dengan password")
	}
	// Email yang sama -> 409.
	w = doJSON(t, h, "POST", "/api/auth/register", `{"name":"B","email":"a@x.id","password":"rahasia1"}`, nil)
	if w.Code != 409 {
		t.Fatalf("email duplikat: mau 409, dapat %d", w.Code)
	}
}

func TestLoginSuccessAndWrongPassword(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret-auth")
	resetLoginAttempts()
	db := openTestDB(t)
	u := makeUser(t, db, "login@x.id", "rahasia1")
	h := handleLogin(db)

	w := doJSON(t, h, "POST", "/api/auth/login", `{"email":"login@x.id","password":"rahasia1"}`, nil)
	if w.Code != 200 {
		t.Fatalf("login benar: mau 200, dapat %d (%s)", w.Code, w.Body.String())
	}
	var out struct {
		Token string `json:"token"`
	}
	json.Unmarshal(w.Body.Bytes(), &out)
	claims := mustParseToken(t, out.Token, "test-secret-auth")
	if uint(claims["uid"].(float64)) != u.ID {
		t.Fatalf("uid token %v != user %d", claims["uid"], u.ID)
	}
	if exp, _ := claims["exp"].(float64); time.Until(time.Unix(int64(exp), 0)) < 24*time.Hour {
		t.Fatalf("token kedaluwarsa terlalu cepat: exp %v", exp)
	}

	// Password salah -> 401, tanpa membocorkan apakah email ada.
	w = doJSON(t, h, "POST", "/api/auth/login", `{"email":"login@x.id","password":"salah"}`, nil)
	if w.Code != 401 {
		t.Fatalf("password salah: mau 401, dapat %d", w.Code)
	}
	// Email tidak terdaftar -> 401 juga (pesan sama).
	w = doJSON(t, h, "POST", "/api/auth/login", `{"email":"tidak@ada.id","password":"salah"}`, nil)
	if w.Code != 401 {
		t.Fatalf("email tidak ada: mau 401, dapat %d", w.Code)
	}
}

func TestLoginSuspendedAccount(t *testing.T) {
	resetLoginAttempts()
	db := openTestDB(t)
	u := makeUser(t, db, "suspend@x.id", "rahasia1")
	db.Model(&u).Update("suspended", true)
	w := doJSON(t, handleLogin(db), "POST", "/api/auth/login", `{"email":"suspend@x.id","password":"rahasia1"}`, nil)
	if w.Code != 403 {
		t.Fatalf("akun ditangguhkan: mau 403, dapat %d (%s)", w.Code, w.Body.String())
	}
}

func TestLoginLockoutAfterFiveFails(t *testing.T) {
	resetLoginAttempts()
	db := openTestDB(t)
	makeUser(t, db, "kunci@x.id", "rahasia1")
	h := handleLogin(db)
	bad := `{"email":"kunci@x.id","password":"salah"}`
	for i := 0; i < 5; i++ {
		if w := doJSON(t, h, "POST", "/api/auth/login", bad, nil); w.Code != 401 {
			t.Fatalf("gagal ke-%d: mau 401, dapat %d", i+1, w.Code)
		}
	}
	// Percobaan ke-6 — bahkan dengan password BENAR — harus 429 (terkunci 15 mnt).
	w := doJSON(t, h, "POST", "/api/auth/login", `{"email":"kunci@x.id","password":"rahasia1"}`, nil)
	if w.Code != 429 {
		t.Fatalf("setelah 5 gagal: mau 429, dapat %d (%s)", w.Code, w.Body.String())
	}
}

func TestLoginSuccessResetsFailCounter(t *testing.T) {
	resetLoginAttempts()
	db := openTestDB(t)
	makeUser(t, db, "reset@x.id", "rahasia1")
	h := handleLogin(db)
	bad := `{"email":"reset@x.id","password":"salah"}`
	for i := 0; i < 4; i++ {
		doJSON(t, h, "POST", "/api/auth/login", bad, nil)
	}
	// Login sukses menghapus hitungan gagal: 4 gagal berikutnya tidak boleh mengunci.
	if w := doJSON(t, h, "POST", "/api/auth/login", `{"email":"reset@x.id","password":"rahasia1"}`, nil); w.Code != 200 {
		t.Fatalf("login sukses: mau 200, dapat %d", w.Code)
	}
	for i := 0; i < 4; i++ {
		if w := doJSON(t, h, "POST", "/api/auth/login", bad, nil); w.Code != 401 {
			t.Fatalf("gagal ke-%d setelah reset: mau 401, dapat %d", i+1, w.Code)
		}
	}
	if w := doJSON(t, h, "POST", "/api/auth/login", `{"email":"reset@x.id","password":"rahasia1"}`, nil); w.Code != 200 {
		t.Fatalf("login setelah 4 gagal pasca-reset: mau 200, dapat %d (terkunci prematur)", w.Code)
	}
}

func TestLoginTOTPRequired(t *testing.T) {
	resetLoginAttempts()
	db := openTestDB(t)
	u := makeUser(t, db, "totp@x.id", "rahasia1")
	key, err := totp.Generate(totp.GenerateOpts{Issuer: "WebBuilder", AccountName: u.Email})
	if err != nil {
		t.Fatalf("totp generate: %v", err)
	}
	db.Create(&models.UserTOTP{UserID: u.ID, Secret: key.Secret(), Enabled: true})
	h := handleLogin(db)
	body := `{"email":"totp@x.id","password":"rahasia1"}`

	// Tanpa header X-OTP -> 402 needOTP.
	w := doJSON(t, h, "POST", "/api/auth/login", body, nil)
	if w.Code != 402 {
		t.Fatalf("tanpa OTP: mau 402, dapat %d (%s)", w.Code, w.Body.String())
	}
	// OTP salah -> 401.
	w = doJSON(t, h, "POST", "/api/auth/login", body, func(r *http.Request) { r.Header.Set("X-OTP", "000000") })
	if w.Code != 401 {
		t.Fatalf("OTP salah: mau 401, dapat %d", w.Code)
	}
	// OTP benar -> 200.
	code, err := totp.GenerateCode(key.Secret(), time.Now())
	if err != nil {
		t.Fatalf("totp code: %v", err)
	}
	w = doJSON(t, h, "POST", "/api/auth/login", body, func(r *http.Request) { r.Header.Set("X-OTP", code) })
	if w.Code != 200 {
		t.Fatalf("OTP benar: mau 200, dapat %d (%s)", w.Code, w.Body.String())
	}
}

func TestAuthMiddlewareJWT(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret-mw")
	db := openTestDB(t)
	u := makeUser(t, db, "mw@x.id", "rahasia1")

	r := gin.New()
	r.Use(authMiddleware(db))
	r.GET("/x", func(c *gin.Context) { c.JSON(200, gin.H{"uid": c.GetUint("userID")}) })
	call := func(auth string, query string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/x"+query, nil)
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		r.ServeHTTP(w, req)
		return w
	}

	// Tanpa token -> 401.
	if w := call("", ""); w.Code != 401 {
		t.Fatalf("tanpa token: mau 401, dapat %d", w.Code)
	}
	// Token rusak -> 401.
	if w := call("Bearer ini.bukan.token", ""); w.Code != 401 {
		t.Fatalf("token rusak: mau 401, dapat %d", w.Code)
	}
	// Token ditandatangani secret lain -> 401.
	other, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"uid": u.ID, "exp": time.Now().Add(time.Hour).Unix()}).SignedString([]byte("secret-lain"))
	if w := call("Bearer "+other, ""); w.Code != 401 {
		t.Fatalf("token secret lain: mau 401, dapat %d", w.Code)
	}
	// Token kedaluwarsa -> 401.
	expired, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"uid": u.ID, "exp": time.Now().Add(-time.Hour).Unix()}).SignedString([]byte("test-secret-mw"))
	if w := call("Bearer "+expired, ""); w.Code != 401 {
		t.Fatalf("token kedaluwarsa: mau 401, dapat %d", w.Code)
	}
	// Token tanpa uid / uid bukan angka -> 401.
	noUID, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"exp": time.Now().Add(time.Hour).Unix()}).SignedString([]byte("test-secret-mw"))
	if w := call("Bearer "+noUID, ""); w.Code != 401 {
		t.Fatalf("token tanpa uid: mau 401, dapat %d", w.Code)
	}
	// Token sah via header -> 200 + uid benar.
	tok := makeToken(u.ID)
	w := call("Bearer "+tok, "")
	if w.Code != 200 {
		t.Fatalf("token sah: mau 200, dapat %d (%s)", w.Code, w.Body.String())
	}
	var out struct {
		UID uint `json:"uid"`
	}
	json.Unmarshal(w.Body.Bytes(), &out)
	if out.UID != u.ID {
		t.Fatalf("uid context %d != %d", out.UID, u.ID)
	}
	// Token sah via query ?token= (jalur iframe preview) -> 200.
	w = call("", "?token="+tok)
	if w.Code != 200 {
		t.Fatalf("token via query: mau 200, dapat %d", w.Code)
	}
}

func TestAuthMiddlewareAPIKey(t *testing.T) {
	db := openTestDB(t)
	u := makeUser(t, db, "key@x.id", "rahasia1")
	rawKey := "wb_" + randHex(16)
	db.Create(&models.UserAPIKey{UserID: u.ID, Name: "tes", KeyHash: sha256Hex(rawKey), Prefix: rawKey[:8]})

	r := gin.New()
	r.Use(authMiddleware(db))
	r.GET("/x", func(c *gin.Context) { c.JSON(200, gin.H{"uid": c.GetUint("userID")}) })
	call := func(key string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/x", nil)
		req.Header.Set("Authorization", "Bearer "+key)
		r.ServeHTTP(w, req)
		return w
	}

	// API key sah -> 200 + last_used terisi.
	w := call(rawKey)
	if w.Code != 200 {
		t.Fatalf("api key sah: mau 200, dapat %d (%s)", w.Code, w.Body.String())
	}
	var k models.UserAPIKey
	db.Where("user_id = ?", u.ID).First(&k)
	if k.LastUsed == nil {
		t.Fatal("last_used API key tidak diperbarui")
	}
	// API key salah -> 401 (bukan 200, bukan 500).
	if w := call("wb_" + randHex(16)); w.Code != 401 {
		t.Fatalf("api key salah: mau 401, dapat %d", w.Code)
	}
	// Token pv_ di luar jalur preview -> 401 (tidak boleh lolos sebagai JWT).
	if w := call("pv_" + randHex(8)); w.Code != 401 {
		t.Fatalf("preview token di luar preview: mau 401, dapat %d", w.Code)
	}
}

func TestForgotPasswordDoesNotLeakExistence(t *testing.T) {
	db := openTestDB(t)
	makeUser(t, db, "ada@x.id", "rahasia1")
	h := forgotPassword(db)

	// Email terdaftar dan tidak terdaftar: respons IDENTIK (200 + pesan sama),
	// hanya yang terdaftar yang membuat baris PasswordReset.
	wKnown := doJSON(t, h, "POST", "/api/auth/forgot-password", `{"email":"ada@x.id"}`, nil)
	wUnknown := doJSON(t, h, "POST", "/api/auth/forgot-password", `{"email":"tidak@ada.id"}`, nil)
	if wKnown.Code != 200 || wUnknown.Code != 200 {
		t.Fatalf("mau 200/200, dapat %d/%d", wKnown.Code, wUnknown.Code)
	}
	if wKnown.Body.String() != wUnknown.Body.String() {
		t.Fatalf("respons bocor: terdaftar=%q tidak=%q", wKnown.Body.String(), wUnknown.Body.String())
	}
	var n int64
	db.Model(&models.PasswordReset{}).Count(&n)
	if n != 1 {
		t.Fatalf("mau tepat 1 token reset (untuk email terdaftar), dapat %d", n)
	}
}

func TestResetPasswordFlow(t *testing.T) {
	db := openTestDB(t)
	u := makeUser(t, db, "resetpw@x.id", "lama123")
	h := resetPassword(db)
	do := func(body string) *httptest.ResponseRecorder {
		return doJSON(t, h, "POST", "/api/auth/reset-password", body, nil)
	}

	// Token tidak ada -> 400.
	if w := do(`{"token":"tidakada","new":"baru123"}`); w.Code != 400 {
		t.Fatalf("token tidak ada: mau 400, dapat %d", w.Code)
	}
	// Token kedaluwarsa -> 400, password tidak berubah.
	db.Create(&models.PasswordReset{UserID: u.ID, Token: "tok-exp", ExpiresAt: time.Now().Add(-time.Minute)})
	if w := do(`{"token":"tok-exp","new":"baru123"}`); w.Code != 400 {
		t.Fatalf("token kedaluwarsa: mau 400, dapat %d", w.Code)
	}
	// Token sah -> 200, password berubah, token sekali pakai.
	db.Create(&models.PasswordReset{UserID: u.ID, Token: "tok-ok", ExpiresAt: time.Now().Add(30 * time.Minute)})
	if w := do(`{"token":"tok-ok","new":"baru123"}`); w.Code != 200 {
		t.Fatalf("token sah: mau 200, dapat %d (%s)", w.Code, w.Body.String())
	}
	var stored models.User
	db.First(&stored, u.ID)
	if err := bcrypt.CompareHashAndPassword([]byte(stored.Password), []byte("baru123")); err != nil {
		t.Fatal("password tidak berubah setelah reset")
	}
	// Token yang sama dipakai lagi -> 400 (sekali pakai).
	if w := do(`{"token":"tok-ok","new":"lain123"}`); w.Code != 400 {
		t.Fatalf("token dipakai ulang: mau 400, dapat %d", w.Code)
	}
	// Password baru < 6 karakter -> 400.
	db.Create(&models.PasswordReset{UserID: u.ID, Token: "tok-pendek", ExpiresAt: time.Now().Add(30 * time.Minute)})
	if w := do(`{"token":"tok-pendek","new":"123"}`); w.Code != 400 {
		t.Fatalf("password baru pendek: mau 400, dapat %d", w.Code)
	}
}
