package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// Minimal SSH reverse-tunnel client for no-account public edges
// (localhost.run / serveo.net / pinggy.io). Pure Go, CGO-free → cross-compiles
// to android/{arm64,amd64} with no NDK. Exposes a local HTTP port as a public
// https URL, decentralized (no user-owned server).

var urlRe = regexp.MustCompile(`https?://[a-zA-Z0-9._-]+\.(lhr\.life|serveo\.net|pinggy\.link|a\.pinggy\.io)[^\s]*`)

func main() {
	host := flag.String("host", "localhost.run:22", "ssh edge host:port")
	user := flag.String("user", "nokey", "ssh user")
	local := flag.Int("local", 8080, "local port to expose")
	flag.Parse()

	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		fmt.Println("keygen:", err)
		os.Exit(1)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		fmt.Println("signer:", err)
		os.Exit(1)
	}
	cfg := &ssh.ClientConfig{
		User:            *user,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer), ssh.Password("")},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         15 * time.Second,
	}
	fmt.Println("dialing", *host, "as", *user)
	cli, err := ssh.Dial("tcp", *host, cfg)
	if err != nil {
		fmt.Println("dial:", err)
		os.Exit(2)
	}
	defer cli.Close()
	fmt.Println("connected")

	// Request remote forward of port 80 (HTTP edge maps it to an https URL).
	go acceptForwards(cli, *local)
	payload := ssh.Marshal(struct {
		Addr string
		Port uint32
	}{"", 80})
	ok, reply, err := cli.SendRequest("tcpip-forward", true, payload)
	if err != nil || !ok {
		fmt.Printf("tcpip-forward ok=%v err=%v\n", ok, err)
	} else if len(reply) >= 4 {
		fmt.Println("forward bound port:", binary.BigEndian.Uint32(reply))
	}

	// Open a session; the edge prints the assigned URL on the shell stdout.
	sess, err := cli.NewSession()
	if err != nil {
		fmt.Println("session:", err)
		os.Exit(3)
	}
	defer sess.Close()
	stdout, _ := sess.StdoutPipe()
	stderr, _ := sess.StderrPipe()
	sess.RequestPty("xterm", 40, 120, ssh.TerminalModes{})
	if err := sess.Shell(); err != nil {
		fmt.Println("shell:", err)
	}
	go scanForURL("stdout", stdout)
	go scanForURL("stderr", stderr)

	// Keep alive.
	for {
		time.Sleep(30 * time.Second)
		cli.SendRequest("keepalive@openssh.com", false, nil)
	}
}

func scanForURL(tag string, r io.Reader) {
	buf := make([]byte, 4096)
	var acc strings.Builder
	for {
		n, err := r.Read(buf)
		if n > 0 {
			s := string(buf[:n])
			acc.WriteString(s)
			if m := urlRe.FindString(acc.String()); m != "" {
				fmt.Println("PUBLIC_URL:", m)
			}
		}
		if err != nil {
			return
		}
	}
}

func acceptForwards(cli *ssh.Client, localPort int) {
	ch := cli.HandleChannelOpen("forwarded-tcpip")
	if ch == nil {
		return
	}
	for newCh := range ch {
		go func(nc ssh.NewChannel) {
			c, reqs, err := nc.Accept()
			if err != nil {
				return
			}
			go ssh.DiscardRequests(reqs)
			up, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", localPort))
			if err != nil {
				c.Close()
				return
			}
			go func() { io.Copy(up, c); up.Close() }()
			io.Copy(c, up)
			c.Close()
		}(newCh)
	}
}
