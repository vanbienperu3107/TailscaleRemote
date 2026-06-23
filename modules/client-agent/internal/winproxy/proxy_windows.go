// Package winproxy sets/clears the Windows system PAC (auto-config) URL
// so browsers using system proxy settings automatically point to the API-generated PAC.
// Uses reg.exe — no external Go dependencies.
package winproxy

import (
	"log"
	"os/exec"
)

const regKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`

// SetPAC writes AutoConfigURL to the Windows Internet Settings registry and
// disables manual proxy (ProxyEnable=0). New browser connections pick this up
// without a restart.
func SetPAC(pacURL string) {
	run("reg", "add", regKey, "/v", "AutoConfigURL", "/t", "REG_SZ", "/d", pacURL, "/f")
	run("reg", "add", regKey, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f")
	// Notify WinInet so running browsers pick up the change (best-effort).
	exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", "about:blank").Start()
	log.Printf("[winproxy] PAC set → %s", pacURL)
}

// ClearPAC removes AutoConfigURL (restores direct/no-proxy).
func ClearPAC() {
	exec.Command("reg", "delete", regKey, "/v", "AutoConfigURL", "/f").Run()
	run("reg", "add", regKey, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f")
	log.Println("[winproxy] PAC cleared")
}

func run(name string, args ...string) {
	if err := exec.Command(name, args...).Run(); err != nil {
		log.Printf("[winproxy] %s %v: %v", name, args, err)
	}
}
