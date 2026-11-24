package handler

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"os"
)

// AIKeyEncryptor encrypts AI provider API keys at rest with AES-256-GCM.
// The 32-byte key is loaded from ~/.webbuilder-key (mode 600) or the
// WEBBUILDER_KEY env var (base64). Generated once if missing.
type AIKeyEncryptor struct {
	gcm cipher.AEAD
}

func loadAIKeyEncryptor() (*AIKeyEncryptor, error) {
	keyPath := os.ExpandEnv("$HOME/.webbuilder-key")
	keyBytes, err := os.ReadFile(keyPath)
	if err != nil {
		if v := os.Getenv("WEBBUILDER_KEY"); v != "" {
			if raw, derr := base64.StdEncoding.DecodeString(v); derr == nil && len(raw) == 32 {
				return newEncryptor(raw)
			}
		}
		// generate fresh key
		raw := make([]byte, 32)
		if _, err := io.ReadFull(rand.Reader, raw); err != nil {
			return nil, fmt.Errorf("generate key: %w", err)
		}
		if err := os.WriteFile(keyPath, []byte(base64.StdEncoding.EncodeToString(raw)), 0600); err != nil {
			return nil, fmt.Errorf("persist key: %w", err)
		}
		return newEncryptor(raw)
	}
	raw, err := base64.StdEncoding.DecodeString(string(keyBytes))
	if err != nil || len(raw) != 32 {
		return nil, fmt.Errorf("invalid key file: need 32 bytes base64")
	}
	return newEncryptor(raw)
}

func newEncryptor(raw []byte) (*AIKeyEncryptor, error) {
	block, err := aes.NewCipher(raw)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &AIKeyEncryptor{gcm: gcm}, nil
}

func (e *AIKeyEncryptor) Encrypt(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	nonce := make([]byte, e.gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ct := e.gcm.Seal(nonce, nonce, []byte(plain), nil)
	return "enc1:" + base64.StdEncoding.EncodeToString(ct), nil
}

func (e *AIKeyEncryptor) Decrypt(stored string) (string, error) {
	if stored == "" {
		return "", nil
	}
	if len(stored) < 5 || stored[:5] != "enc1:" {
		return "", fmt.Errorf("not encrypted (legacy plaintext key)")
	}
	ct, err := base64.StdEncoding.DecodeString(stored[5:])
	if err != nil {
		return "", err
	}
	nonceSize := e.gcm.NonceSize()
	if len(ct) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}
	plain, err := e.gcm.Open(nil, ct[:nonceSize], ct[nonceSize:], nil)
	if err != nil {
		return "", fmt.Errorf("decrypt failed: %w", err)
	}
	return string(plain), nil
}
