package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// OAuth Google & GitHub — client ID/secret diisi admin di Platform settings.

func oauthStart(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		provider := c.Param("provider")
		clientID := getSetting(db, "oauth_"+provider+"_client_id")
		if clientID == "" {
			c.JSON(500, gin.H{"message": "OAuth " + provider + " belum dikonfigurasi admin"})
			return
		}
		redirectURI := siteBaseURL(db) + "/api/auth/oauth/" + provider + "/callback"
		var authURL string
		if provider == "google" {
			authURL = "https://accounts.google.com/o/oauth2/v2/auth?" + url.Values{
				"client_id": {clientID}, "redirect_uri": {redirectURI},
				"response_type": {"code"}, "scope": {"openid email profile"},
				"state": {randHex(8)},
			}.Encode()
		} else if provider == "github" {
			authURL = "https://github.com/login/oauth/authorize?" + url.Values{
				"client_id": {clientID}, "redirect_uri": {redirectURI},
				"scope": {"read:user user:email"}, "state": {randHex(8)},
			}.Encode()
		} else {
			c.JSON(400, gin.H{"message": "Provider tidak dikenal"})
			return
		}
		c.JSON(200, gin.H{"url": authURL})
	}
}

func oauthCallback(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		provider := c.Param("provider")
		code := c.Query("code")
		if code == "" {
			c.String(400, "Kode tidak ada")
			return
		}
		clientID := getSetting(db, "oauth_"+provider+"_client_id")
		encSecret := getSetting(db, "oauth_"+provider+"_client_secret")
		clientSecret, err := keyEnc.Decrypt(encSecret)
		if err != nil || clientID == "" {
			c.String(500, "OAuth belum dikonfigurasi")
			return
		}
		redirectURI := siteBaseURL(db) + "/api/auth/oauth/" + provider + "/callback"

		var token string
		var email, name string
		if provider == "google" {
			token, err = exchangeCode("https://oauth2.googleapis.com/token", url.Values{
				"code": {code}, "client_id": {clientID}, "client_secret": {clientSecret},
				"redirect_uri": {redirectURI}, "grant_type": {"authorization_code"},
			})
			if err != nil {
				c.String(500, "Gagal tukar kode")
				return
			}
			email, name, err = googleProfile(token)
		} else if provider == "github" {
			token, err = exchangeCode("https://github.com/login/oauth/access_token", url.Values{
				"code": {code}, "client_id": {clientID}, "client_secret": {clientSecret},
				"redirect_uri": {redirectURI},
			})
			if err != nil {
				c.String(500, "Gagal tukar kode")
				return
			}
			email, name, err = githubProfile(token)
		} else {
			c.String(400, "Provider tidak dikenal")
			return
		}
		if err != nil || email == "" {
			c.String(500, "Gagal ambil profil")
			return
		}

		// login atau daftar
		var u models.User
		if err := db.Where("email = ?", email).First(&u).Error; err != nil {
			u = models.User{Name: name, Email: email, ReferralCode: "WB" + randHex(6)}
			db.Create(&u)
			audit(db, u.ID, "register.oauth", provider, c.ClientIP())
		}
		if u.Suspended {
			c.String(403, "Akun ditangguhkan")
			return
		}
		tok := makeToken(u.ID)
		// redirect ke frontend dengan token
		c.Redirect(302, siteBaseURL(db)+"/oauth?token="+tok)
	}
}

func exchangeCode(tokenURL string, v url.Values) (string, error) {
	resp, err := http.PostForm(tokenURL, v)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	// coba JSON dulu, lalu query string
	var jd map[string]interface{}
	if json.Unmarshal(body, &jd) == nil {
		if t, ok := jd["access_token"].(string); ok && t != "" {
			return t, nil
		}
	}
	q, _ := url.ParseQuery(string(body))
	if t := q.Get("access_token"); t != "" {
		return t, nil
	}
	return "", fmt.Errorf("no token: %s", string(body)[:100])
}

func googleProfile(token string) (email, name string, err error) {
	req, _ := http.NewRequest("GET", "https://www.googleapis.com/oauth2/v2/userinfo", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := httpClient().Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	var p struct {
		Email string `json:"email"`
		Name  string `json:"name"`
	}
	body, _ := io.ReadAll(resp.Body)
	json.Unmarshal(body, &p)
	return p.Email, p.Name, nil
}

func githubProfile(token string) (email, name string, err error) {
	req, _ := http.NewRequest("GET", "https://api.github.com/user", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := httpClient().Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	var p struct {
		Email string `json:"email"`
		Name  string `json:"name"`
		Login string `json:"login"`
	}
	body, _ := io.ReadAll(resp.Body)
	json.Unmarshal(body, &p)
	if p.Email == "" {
		// ambil dari /user/emails
		req2, _ := http.NewRequest("GET", "https://api.github.com/user/emails", nil)
		req2.Header.Set("Authorization", "Bearer "+token)
		req2.Header.Set("Accept", "application/vnd.github+json")
		resp2, err2 := httpClient().Do(req2)
		if err2 == nil {
			defer resp2.Body.Close()
			var es []struct {
				Email   string `json:"email"`
				Primary bool   `json:"primary"`
			}
			b2, _ := io.ReadAll(resp2.Body)
			json.Unmarshal(b2, &es)
			for _, e := range es {
				if e.Primary {
					p.Email = e.Email
					break
				}
			}
			if p.Email == "" && len(es) > 0 {
				p.Email = es[0].Email
			}
		}
	}
	if p.Name == "" {
		p.Name = p.Login
	}
	return p.Email, p.Name, nil
}

func oauthStatus(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(200, gin.H{
			"google": getSetting(db, "oauth_google_client_id") != "",
			"github": getSetting(db, "oauth_github_client_id") != "",
		})
	}
}

var _ = strings.TrimSpace
