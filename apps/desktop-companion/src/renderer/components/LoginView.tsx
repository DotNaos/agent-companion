import { buttonVariants } from "./ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card.js";

export function LoginView() {
  return (
    <Card className="login-shell">
      <CardHeader className="p-7">
        <p className="eyebrow">agent-companion</p>
        <CardTitle className="text-5xl">
          Remote admin sign-in required
        </CardTitle>
        <CardDescription>
          The remote admin interface is protected by Google OAuth and the local
          admin allowlist. Sign in to manage permissions, approvals, and
          activity from another device.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-7 pb-7 pt-0">
        <a
          className={buttonVariants({ variant: "default" })}
          href="/auth/login/google"
        >
          Continue With Google
        </a>
      </CardContent>
    </Card>
  );
}
