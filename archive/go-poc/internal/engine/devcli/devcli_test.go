package devcli

import (
	"reflect"
	"testing"

	"github.com/klerik3d/gurt/internal/engine"
)

func TestParseUpResult(t *testing.T) {
	tests := []struct {
		name    string
		out     string
		want    *upResult
		wantErr bool
	}{
		{
			name: "success with leading noise",
			out: "npm warn something\n" +
				`{"outcome":"success","containerId":"abc123","remoteUser":"vscode","remoteWorkspaceFolder":"/workspaces/app"}` + "\n",
			want: &upResult{
				Outcome:               "success",
				ContainerID:           "abc123",
				RemoteUser:            "vscode",
				RemoteWorkspaceFolder: "/workspaces/app",
			},
		},
		{
			name: "error outcome",
			out:  `{"outcome":"error","message":"Dockerfile not found","description":"An error occurred building the image"}`,
			want: &upResult{
				Outcome:     "error",
				Message:     "Dockerfile not found",
				Description: "An error occurred building the image",
			},
		},
		{
			name:    "no outcome object",
			out:     "some log line\n{\"unrelated\":true}\n",
			wantErr: true,
		},
		{
			name:    "empty output",
			out:     "",
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseUpResult([]byte(tt.out))
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr = %v", err, tt.wantErr)
			}
			if err == nil && !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestDecodeInspect(t *testing.T) {
	data := `[
	  {
	    "Id": "abc123",
	    "State": {"Running": true},
	    "Config": {"Labels": {"gurt.workspace": "personal", "gurt.envtype": "dev"}}
	  },
	  {
	    "Id": "def456",
	    "State": {"Running": false},
	    "Config": {"Labels": {}}
	  }
	]`
	got, err := decodeInspect([]byte(data))
	if err != nil {
		t.Fatal(err)
	}
	want := []engine.Container{
		{ID: "abc123", Running: true, Labels: map[string]string{"gurt.workspace": "personal", "gurt.envtype": "dev"}},
		{ID: "def456", Running: false, Labels: map[string]string{}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestExecArgv(t *testing.T) {
	plain := engine.ExecSpec{Argv: []string{"claude", "--version"}}
	if got := execArgv(plain); !reflect.DeepEqual(got, plain.Argv) {
		t.Fatalf("got %v, want argv unchanged", got)
	}

	withDir := engine.ExecSpec{Argv: []string{"ls", "-la"}, Dir: "/workspaces/app/sub"}
	want := []string{"/bin/sh", "-c", `cd "$0" && exec "$@"`, "/workspaces/app/sub", "ls", "-la"}
	if got := execArgv(withDir); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestPairArgs(t *testing.T) {
	got := pairArgs("--id-label", map[string]string{"gurt.task": "t1", "gurt.repo": "app"})
	want := []string{"--id-label", "gurt.repo=app", "--id-label", "gurt.task=t1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}
