//go:build !windows

package winproxy

import "log"

func SetPAC(pacURL string) { log.Printf("[winproxy] (stub) SetPAC %s", pacURL) }
func ClearPAC()            { log.Println("[winproxy] (stub) ClearPAC") }
