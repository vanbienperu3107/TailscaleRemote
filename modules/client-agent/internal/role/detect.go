package role

import (
	"net"
	"strings"
)

// Detect returns "itop" if any local IPv4 starts with prefix, else "votam".
func Detect(prefix string) string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "votam"
	}
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipnet.IP.To4()
		if ip == nil {
			continue
		}
		if strings.HasPrefix(ip.String(), prefix) {
			return "itop"
		}
	}
	return "votam"
}
