package ing.yama.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * The app's card finder on camera frames (NativeFinder): frames as the camera delivers them (grey
 * YUV with the parity fixture's card in the luma) go in, and each result the page is handed carries
 * that frame's pixels and the corners found on exactly those pixels. A detector that fails stops it
 * for good, and says so once: the page's own finder takes over.
 */
public class NativeFinderTest {

    private static final int W = 640;
    private static final int H = 1138;

    /** An upright camera frame of the fixture's frame `i`: its red channel as the luma, chroma grey. */
    private static void put(ScannerFrames frames, JSONObject card) throws Exception {
        byte[] rgba = CardFinderTest.frame(W, H, card);
        byte[] y = new byte[W * H];
        for (int k = 0; k < y.length; k++) y[k] = rgba[k * 4];
        byte[] chroma = new byte[W * (H / 2)];
        java.util.Arrays.fill(chroma, (byte) 128);
        frames.put(ByteBuffer.wrap(y), ByteBuffer.wrap(chroma), ByteBuffer.wrap(chroma), W, W, 2, 0, 0, W, H, 0);
    }

    private static NativeFinder finder(ScannerFrames frames, CardFinder.Detector d) throws Exception {
        NativeFinder f = new NativeFinder(frames);
        f.use("test", d, CardFinderTest.constants(CardFinderTest.fixture().getJSONObject("constants")), 640);
        return f;
    }

    @Test
    public void eachResultIsTheFrameAndTheCornersFoundOnIt() throws Exception {
        JSONArray cards = CardFinderTest.fixture().getJSONArray("frames");
        ScannerFrames frames = new ScannerFrames();
        NativeFinder f = finder(frames, new CardFinderTest.FakeDetector());
        AtomicInteger wanted = new AtomicInteger();
        f.start(wanted::incrementAndGet, null, why -> {});
        try {
            CardFinder reference = new CardFinder(new CardFinderTest.FakeDetector(), CardFinderTest.constants(CardFinderTest.fixture().getJSONObject("constants")));
            long after = 0;
            for (int i = 0; i < 3; i++) {
                put(frames, cards.getJSONObject(i));
                NativeFinder.Snapshot s = f.take(after, 5000, 8);
                assertNotNull("frame " + i + " was found", s);
                after = s.seq;
                assertEquals(W, s.width);
                assertEquals(H, s.height);
                assertEquals(8 + W * H * 4, s.bytes.length);
                // The very pixels the finder looked at, after the header's room.
                byte[] pixels = java.util.Arrays.copyOfRange(s.bytes, 8, s.bytes.length);
                CardFinder.Result r = reference.find(new CardFinder.Frame(W, H, pixels, 0));
                assertEquals(r.inView ? NativeFinder.STATE_CARD : NativeFinder.STATE_NONE, s.state);
                assertTrue("frame " + i + " has a card", r.inView);
                assertArrayEquals(r.quad, s.quad, 1e-9);
                assertEquals(r.runs.length, s.passes);
            }
            assertTrue("the camera was kept copying frames", wanted.get() > 0);
            // Nothing newer: nothing handed.
            assertNull(f.take(after, 50, 8));
            put(frames, null);
            NativeFinder.Snapshot empty = f.take(after, 5000, 8);
            assertEquals(NativeFinder.STATE_NONE, empty.state);
            assertNull(empty.quad);
        } finally {
            f.stop();
        }
        assertFalse(f.running());
        assertNull(f.failure());
    }

    @Test
    public void theLiveFinderRunsAtTheSpeedTestsPriority() throws Exception {
        // One below normal is a niceness of 10 on Android: about a ninth of the processor the
        // speed test's finder gets when the camera, the web view and the art read are busy.
        ScannerFrames frames = new ScannerFrames();
        CardFinderTest.FakeDetector fake = new CardFinderTest.FakeDetector();
        AtomicInteger priority = new AtomicInteger();
        NativeFinder f = finder(frames, window -> {
            priority.compareAndSet(0, Thread.currentThread().getPriority());
            return fake.run(window);
        });
        f.start(() -> {}, null, why -> {});
        try {
            put(frames, CardFinderTest.fixture().getJSONArray("frames").getJSONObject(0));
            assertNotNull(f.take(0, 5000, 8));
            assertEquals(Thread.NORM_PRIORITY, priority.get());
            // And where its time went, for the page's records.
            double[] stages = f.stages();
            assertTrue("the frame was scaled for the finder", stages[0] > 0);
            assertTrue("the wait for the camera was timed", stages[1] >= 0);
            assertTrue("the camera's copy was timed", frames.copyMs() > 0);
        } finally {
            f.stop();
        }
    }

    @Test
    public void stoppingNeverWaitsForARunUnderWay() throws Exception {
        ScannerFrames frames = new ScannerFrames();
        java.util.concurrent.CountDownLatch inRun = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        CardFinderTest.FakeDetector fake = new CardFinderTest.FakeDetector();
        // A run that takes as long as ONNX Runtime may on a slow phone, and can't be interrupted.
        CardFinder.Detector slow = window -> {
            inRun.countDown();
            while (true) {
                try {
                    if (release.await(5, java.util.concurrent.TimeUnit.SECONDS)) break;
                } catch (InterruptedException ignored) {
                    // Native code doesn't hear interrupts either.
                }
            }
            return fake.run(window);
        };
        NativeFinder f = finder(frames, slow);
        AtomicInteger told = new AtomicInteger();
        f.start(() -> {}, null, why -> told.incrementAndGet());
        put(frames, CardFinderTest.fixture().getJSONArray("frames").getJSONObject(0));
        assertTrue("a run began", inRun.await(5, java.util.concurrent.TimeUnit.SECONDS));
        // Forgetting the tracked card doesn't wait for the run either.
        long r0 = System.nanoTime();
        f.resetTracking();
        assertTrue("reset returned at once", (System.nanoTime() - r0) / 1e6 < 200);
        long t0 = System.nanoTime();
        f.stop();
        assertTrue("stop returned at once", (System.nanoTime() - t0) / 1e6 < 200);
        assertFalse(f.running());
        release.countDown();
        // The stopped loop finishes its run and publishes nothing, and isn't taken for a failure.
        assertNull(f.take(0, 300, 8));
        Thread.sleep(100);
        assertNull(f.failure());
        assertEquals(0, told.get());
    }

    @Test
    public void aLoadThatFinishesAfterShutdownLetsItsModelGo() throws Exception {
        ScannerFrames frames = new ScannerFrames();
        NativeFinder f = finder(frames, new CardFinderTest.FakeDetector());
        f.shutdown();
        // Let go on a thread of its own.
        for (int i = 0; i < 100 && f.loaded(); i++) Thread.sleep(10);
        assertFalse(f.loaded());
        AtomicInteger closed = new AtomicInteger();
        class Closing implements CardFinder.Detector, AutoCloseable {
            @Override
            public CardFinder.Output run(byte[] window) {
                return new CardFinderTest.FakeDetector().run(window);
            }

            @Override
            public void close() {
                closed.incrementAndGet();
            }
        }
        try {
            f.use("late", new Closing(), CardFinderTest.constants(CardFinderTest.fixture().getJSONObject("constants")), 640);
            org.junit.Assert.fail("a load after shutdown was kept");
        } catch (IllegalStateException expected) {
            assertEquals(1, closed.get());
            assertFalse(f.loaded());
        }
    }

    @Test
    public void aFailureStopsItForGoodAndSaysSoOnce() throws Exception {
        ScannerFrames frames = new ScannerFrames();
        AtomicInteger runs = new AtomicInteger();
        CardFinder.Detector broken = window -> {
            if (runs.incrementAndGet() > 1) throw new IllegalStateException("the model ran out of memory");
            return new CardFinderTest.FakeDetector().run(window);
        };
        NativeFinder f = finder(frames, broken);
        AtomicReference<String> heard = new AtomicReference<>();
        AtomicInteger told = new AtomicInteger();
        f.start(() -> {}, null, why -> {
            heard.set(why);
            told.incrementAndGet();
        });
        JSONArray cards = CardFinderTest.fixture().getJSONArray("frames");
        put(frames, cards.getJSONObject(0));
        for (int i = 0; i < 100 && f.running(); i++) Thread.sleep(20);
        assertFalse("it stopped", f.running());
        assertNotNull(f.failure());
        assertTrue(f.failure().contains("ran out of memory"));
        assertEquals(f.failure(), heard.get());
        assertEquals(1, told.get());
        // The page asks: nothing, at once, rather than waiting on a finder that has stopped.
        long t0 = System.nanoTime();
        assertNull(f.take(0, 2000, 8));
        assertTrue((System.nanoTime() - t0) / 1e6 < 1000);
        // Asked to run again, it doesn't: the failure stands until it's loaded again.
        try {
            f.start(() -> {}, null, why -> {});
            org.junit.Assert.fail("a finder that failed started again");
        } catch (IllegalStateException expected) {
            assertFalse(f.running());
        }
        f.use("again", new CardFinderTest.FakeDetector(), CardFinderTest.constants(CardFinderTest.fixture().getJSONObject("constants")), 640);
        assertNull(f.failure());
    }
}
