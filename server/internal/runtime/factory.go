package runtime

// DefaultExecutor memilih adapter terbaik yang tersedia di host ini:
// Docker bila daemon benar-benar ada, kalau tidak ProcessExecutor.
// Pilihan ini TIDAK melewati flag eksekusi tenant — kedua adapter tetap
// menolak Run() bila WEBBUILDER_ENABLE_TENANT_EXEC != 1.
func DefaultExecutor(cfg Config) Executor {
	if d := NewDockerExecutor(cfg, ""); d.Available() {
		return d
	}
	return NewProcessExecutor(cfg)
}
