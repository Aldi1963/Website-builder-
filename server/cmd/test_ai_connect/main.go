package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func main() {
	body, _ := json.Marshal(map[string]interface{}{
		"model": "ag/gemini-3-flash",
		"messages": []map[string]string{
			{"role": "system", "content": "You are a web builder assistant."},
			{"role": "user", "content": "Hai! Balas 1 kalimat untuk tes koneksi."},
		},
		"stream": true,
		"max_tokens": 100,
	})
	req, _ := http.NewRequest("POST", "http://127.0.0.1:20128/v1/chat/completions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer sk-wb-...1007")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Println("Connect Error:", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		fmt.Printf("HTTP Error %d: %s\n", resp.StatusCode, string(b))
		return
	}

	fmt.Println("HTTP Status 200 OK! Streaming response:")
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data: ") {
			data := strings.TrimPrefix(line, "data: ")
			if data == "[DONE]" {
				fmt.Println("\n[DONE]")
				break
			}
			var chunk struct {
				Choices []struct {
					Delta struct {
						Content string `json:"content"`
					} `json:"delta"`
				} `json:"choices"`
			}
			if err := json.Unmarshal([]byte(data), &chunk); err == nil {
				if len(chunk.Choices) > 0 {
					fmt.Print(chunk.Choices[0].Delta.Content)
				}
			}
		}
	}
}
