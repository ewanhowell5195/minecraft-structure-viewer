// Serializes every feature in the game's worldgen/feature registry (the same
// list /place feature offers) to its data-pack JSON form via the game's own
// codec. Vanilla builds these in code and ships no feature JSONs in the jar,
// so this dump is what makes them data the viewer can read. Compiled and run
// against the unobfuscated server jar by extract.js.
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.mojang.serialization.JsonOps;
import java.nio.file.Files;
import java.nio.file.Path;
import net.minecraft.SharedConstants;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.Registries;
import net.minecraft.data.registries.VanillaRegistries;
import net.minecraft.resources.RegistryOps;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.levelgen.feature.Feature;

public class FeatureExtract {
  public static void main(String[] args) throws Exception {
    Path out = Path.of(args[0]);
    SharedConstants.tryDetectVersion();
    Bootstrap.bootStrap();
    HolderLookup.Provider registries = worldLookup();
    RegistryOps<JsonElement> ops = RegistryOps.create(JsonOps.INSTANCE, registries);
    Gson gson = new GsonBuilder().setPrettyPrinting().create();
    int n = 0;
    for (Holder.Reference<Feature> ref : registries.lookupOrThrow(Registries.FEATURE).listElements().toList()) {
      String id = keyId(ref.key()).toString();
      int colon = id.indexOf(':');
      String ns = id.substring(0, colon), pathPart = id.substring(colon + 1);
      JsonElement json = (JsonElement) Feature.DIRECT_CODEC.encodeStart(ops, ref.value()).getOrThrow();
      Path dest = out.resolve("data/" + ns + "/worldgen/feature/" + pathPart + ".json");
      Files.createDirectories(dest.getParent());
      Files.writeString(dest, gson.toJson(json));
      n++;
    }
    System.out.println("wrote " + n + " configured features");
  }

  // both renamed across versions: resolve whichever exists at runtime
  static HolderLookup.Provider worldLookup() {
    for (String name : new String[]{ "createWorldLookup", "createLookup" }) {
      try { return (HolderLookup.Provider) VanillaRegistries.class.getMethod(name).invoke(null); }
      catch (NoSuchMethodException e) { continue; }
      catch (Exception e) { throw new RuntimeException(e); }
    }
    throw new RuntimeException("no VanillaRegistries world-lookup factory found");
  }

  static Object keyId(ResourceKey<?> key) {
    for (String name : new String[]{ "identifier", "location" }) {
      try { return ResourceKey.class.getMethod(name).invoke(key); }
      catch (NoSuchMethodException e) { continue; }
      catch (Exception e) { throw new RuntimeException(e); }
    }
    throw new RuntimeException("no ResourceKey id accessor found");
  }
}
