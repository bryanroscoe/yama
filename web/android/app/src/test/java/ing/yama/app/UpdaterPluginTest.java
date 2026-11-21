package ing.yama.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** The updater's reading of a version code from the page. */
public class UpdaterPluginTest {

    /** The page's version code arrives as an Integer; it must not be refused for that. */
    @Test
    public void aVersionCodeThatFitsAnIntIsRead() {
        assertEquals(Long.valueOf(101), UpdaterPlugin.wholeNumber(Integer.valueOf(101)));
        assertEquals(Long.valueOf(5_000_000_000L), UpdaterPlugin.wholeNumber(Long.valueOf(5_000_000_000L)));
    }

    @Test
    public void anythingElseIsNotAVersionCode() {
        assertNull(UpdaterPlugin.wholeNumber(null));
        assertNull(UpdaterPlugin.wholeNumber("101"));
        assertNull(UpdaterPlugin.wholeNumber(Double.valueOf(101.5)));
    }
}
