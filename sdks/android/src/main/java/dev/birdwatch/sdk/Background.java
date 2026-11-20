package dev.birdwatch.sdk;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.os.Bundle;

final class Background implements Application.ActivityLifecycleCallbacks {
  private final Runnable flush;
  private int started;

  private Background(Runnable flush) {
    this.flush = flush;
  }

  static Runnable observe(Context context, Runnable flush) {
    if (!(context instanceof Application)) return () -> {};
    Application app = (Application) context;
    Background observer = new Background(flush);
    app.registerActivityLifecycleCallbacks(observer);
    return () -> app.unregisterActivityLifecycleCallbacks(observer);
  }

  public void onActivityStarted(Activity activity) {
    started++;
  }

  public void onActivityStopped(Activity activity) {
    started = Math.max(0, started - 1);
    if (started == 0 && !activity.isChangingConfigurations()) flush.run();
  }

  public void onActivityCreated(Activity a, Bundle state) {}

  public void onActivityResumed(Activity a) {}

  public void onActivityPaused(Activity a) {}

  public void onActivitySaveInstanceState(Activity a, Bundle state) {}

  public void onActivityDestroyed(Activity a) {}
}
